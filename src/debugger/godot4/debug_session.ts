import {
	Breakpoint,
	BreakpointEvent,
	ContinuedEvent,
	ExitedEvent,
	InitializedEvent,
	LoggingDebugSession,
	OutputEvent,
	Source,
	StoppedEvent,
	TerminatedEvent,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { Subject } from "await-notify";
import * as fs from "node:fs";
import { window, workspace } from "vscode";
import { createLogger, get_project_version } from "../../utils";
import { GodotDebugData } from "../debug_runtime";
import { AttachRequestArguments, LaunchRequestArguments } from "../debugger";
import { InspectorProvider } from "../inspector_provider";
import { SceneTreeProvider } from "../scene_tree_provider";
import { DapController } from "./dap_controller";
import type { DapEvent } from "./dap_client";

const log = createLogger("debugger.session", { output: "Godot Debugger" });

/**
 * Godot 4 debug session speaking DAP to the Godot editor.
 *
 * Architecture (Godot 4 only):
 *   VSCode (DAP client) <-> this session (DAP server + DAP client proxy)
 *     <-> Godot editor Debug Adapter server (default 127.0.0.1:6006)
 *     <-> game (legacy remote-debug protocol, managed by the editor)
 *
 * Godot 3 keeps the legacy direct-to-game protocol
 * (see ../godot3/debug_session.ts + server_controller.ts).
 *
 * Why proxy: the game only connects to the editor, so early breakpoints in
 * _ready/_enter_tree/_init must be registered in the editor BEFORE it spawns
 * the game. VSCode setBreakpoints arriving before launch are buffered locally
 * and replayed to the editor prior to editor launch/configurationDone.
 */
export class GodotDebugSession extends LoggingDebugSession {
	public controller = new DapController(this);
	public debug_data = new GodotDebugData(this);
	public sceneTree: SceneTreeProvider;
	public inspector: InspectorProvider;

	private configuration_done = new Subject();
	private mode: "launch" | "attach" | "" = "";
	private vscodeInitArgs?: DebugProtocol.InitializeRequestArguments;
	private launchArgs?: LaunchRequestArguments;
	private attachArgs?: AttachRequestArguments;
	private editorInitialized = false;
	private editorLaunchSent = false;
	private pendingEditorLaunch?: Promise<any>;
	/** Breakpoints received from VSCode before editor connection. path -> lines */
	private bufferedBreakpoints = new Map<string, number[]>();

	/** Legacy direct-to-game variables manager is not used in Godot 4 DAP mode. Kept as `any` for debugger.ts compat. */
	public variables_manager?: any;

	public constructor(projectVersion: string) {
		super();

		// Editor DAP already adjusts lines/columns for the client
		// (linesStartAt1/columnsStartAt1 handshake), so pass through untouched.
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	public dispose() {
		this.controller.stop();
	}

	protected async initializeRequest(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments,
	) {
		log.info("initializeRequest (DAP proxy)", args);
		this.vscodeInitArgs = args;

		response.body = response.body || {};
		// Mirror Godot editor DAP capabilities
		// (editor/debugger/debug_adapter/debug_adapter_types.h Capabilities).
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsSetVariable = true;
		response.body.supportsRestartRequest = true;
		response.body.supportTerminateDebuggee = true;
		response.body.supportSuspendDebuggee = true;
		response.body.supportsTerminateRequest = true;
		response.body.supportsBreakpointLocationsRequest = true;
		response.body.supportsValueFormattingOptions = true;
		response.body.supportedChecksumAlgorithms = ["MD5", "SHA256"];
		// Not supported by editor DAP (keep explicit for VSCode UI).
		response.body.supportsFunctionBreakpoints = false;
		response.body.supportsConditionalBreakpoints = false;
		response.body.supportsHitConditionalBreakpoints = false;
		response.body.supportsLogPoints = false;
		response.body.supportsDataBreakpoints = false;
		response.body.supportsReadMemoryRequest = false;
		response.body.supportsRestartFrame = false;
		response.body.supportsStepBack = false;
		response.body.supportsSetExpression = false;
		response.body.supportsGotoTargetsRequest = false;
		response.body.supportsStepInTargetsRequest = false;
		response.body.supportsCompletionsRequest = false;
		response.body.supportsModulesRequest = false;
		response.body.supportsTerminateThreadsRequest = false;
		response.body.supportsCancelRequest = false;

		this.sendResponse(response);
		// NOTE: do NOT send InitializedEvent yet. We forward the editor's
		// `initialized` event once connected (or send our own if editor
		// already initialized). To avoid VSCode hanging when editor never
		// sends it (e.g. connection later), send it now and dedupe editor's.
		// Simpler and matches legacy behavior: signal ready now.
		this.sendEvent(new InitializedEvent());
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		log.info("launchRequest (DAP proxy)", args);
		this.mode = "launch";
		this.launchArgs = args;
		this.debug_data.projectPath = args.project;

		try {
			await this.controller.launch(args);
			this.controller.onEvent((event) => this.forwardEditorEvent(event));
			// Initialize editor DAP now (we have host/port + VSCode init args).
			await this.initializeEditor();
			// Replay buffered breakpoints before editor launch so the editor
			// can pass them via --breakpoints CLI to the game.
			await this.replayBufferedBreakpoints();
			// Send editor launch now, but do NOT await its (deferred) response:
			// the editor only answers launch after configurationDone.
			this.pendingEditorLaunch = this.controller.dapLaunch(this.buildEditorLaunchArgs(args));
			this.editorLaunchSent = true;
		} catch (err) {
			log.error("DAP launch failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
			this.sendResponse(response);
			this.sendEvent(new TerminatedEvent());
			return;
		}

		this.sendResponse(response);
		// Wait briefly for VSCode configurationDone (sent after launch response).
		// Actual editor launch completes in configurationDoneRequest.
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments) {
		log.info("attachRequest (DAP proxy)", args);
		this.mode = "attach";
		this.attachArgs = args;
		if (args.project) {
			this.debug_data.projectPath = args.project;
		} else {
			// Fall back to workspace project dir for source mapping.
			try {
				const version = await get_project_version();
				log.info(`attach without project, detected version ${version}`);
			} catch {
				// ignore
			}
		}

		try {
			await this.controller.attach(args);
			this.controller.onEvent((event) => this.forwardEditorEvent(event));
			await this.initializeEditor();
			await this.replayBufferedBreakpoints();
			// Editor attach fails with NOT_RUNNING if no session is active yet.
			// Tolerate it so the user can start VSCode listen FIRST and press
			// Play in the editor AFTER: breakpoints were already synced to the
			// editor and will be passed via --breakpoints CLI, so _ready stops work.
			try {
				await this.controller.dapAttach();
			} catch (attachErr) {
				const msg = attachErr instanceof Error ? attachErr.message : String(attachErr);
				if (/not_running/i.test(msg)) {
					log.warn(
						"No active debug session in the editor yet; keeping VSCode session alive. Press Play in the Godot editor now.",
					);
					window.showInformationMessage(
						"Godot DAP: no running session in the editor yet. Breakpoints synced — press Play in the Godot editor.",
					);
				} else {
					throw attachErr;
				}
			}
			this.editorLaunchSent = true;
		} catch (err) {
			log.error("DAP attach failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
			this.sendResponse(response);
			// Do not terminate immediately; let user see the error.
			// VSCode will end the session on failed attach response.
			return;
		}

		this.sendResponse(response);
	}

	public async configurationDoneRequest(
		response: DebugProtocol.ConfigurationDoneResponse,
		args: DebugProtocol.ConfigurationDoneArguments,
	) {
		log.info("configurationDoneRequest (DAP proxy)", args);
		this.configuration_done.notify();
		try {
			if (this.mode === "launch" && this.editorLaunchSent && this.pendingEditorLaunch) {
				// Trigger editor's _launch_process by sending configurationDone,
				// then await the deferred launch response.
				const configRes = await this.controller.configurationDone();
				log.info("editor configurationDone ok", configRes);
				const launchRes = await this.pendingEditorLaunch;
				log.info("editor launch ok", launchRes);
				this.pendingEditorLaunch = undefined;
			} else if (this.mode === "attach") {
				await this.controller.configurationDone();
			} else {
				// Edge: configurationDone without launch/attach (shouldn't happen).
				log.warn("configurationDone without pending editor launch/attach");
			}
		} catch (err) {
			log.error("DAP configurationDone failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
			this.sendResponse(response);
			return;
		}
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments,
	) {
		const rawPath = args.source.path ?? "";
		const filePath = rawPath.replace(/\\/g, "/");
		const clientLines = args.lines ?? [];
		log.info("setBreakPointsRequest (DAP proxy)", { filePath, clientLines });

		if (!filePath || !fs.existsSync(filePath)) {
			// Untitled / non-file sources: acknowledge with no breakpoints.
			response.body = { breakpoints: [] };
			this.sendResponse(response);
			return;
		}

		// Always buffer locally so early breakpoints survive reconnect/launch ordering.
		this.bufferedBreakpoints.set(filePath, [...clientLines]);

		if (this.editorInitialized && this.controller.connected) {
			try {
				const editorBps = await this.controller.setBreakpoints(filePath, clientLines);
				response.body = {
					breakpoints: (editorBps as any[]).map((bp) => {
						const verified = bp.verified ?? true;
						// Editor lines are already client-adjusted (linesStartAt1 handshake).
						return new Breakpoint(verified, bp.line, 1, new Source(bp.source?.name ?? filePath.split("/").reverse()[0], filePath));
					}),
				};
				this.sendResponse(response);
				return;
			} catch (err) {
				log.error("editor setBreakpoints failed, falling back to local ack", err);
				// Fall through to local ack so VSCode UI stays usable.
			}
		}

		// Not yet connected to editor (pre-launch): acknowledge locally.
		// They will be replayed to the editor before game start.
		const sorted = [...clientLines].sort((a, b) => a - b);
		response.body = {
			breakpoints: sorted.map((line) => new Breakpoint(true, line, 1, new Source(filePath.split("/").reverse()[0], filePath))),
		};
		this.sendResponse(response);
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse) {
		try {
			const body = await this.controller.threads();
			response.body = { threads: body?.threads ?? [{ id: 1, name: "Main" }] };
		} catch (err) {
			log.error("threads failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
		}
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		try {
			const body = await this.controller.stackTrace(args.threadId, args.startFrame ?? 0, args.levels ?? 20);
			const frames = (body?.stackFrames ?? []) as any[];
			response.body = {
				totalFrames: body?.totalFrames ?? frames.length,
				stackFrames: frames.map((sf) => ({
					id: sf.id,
					name: sf.name,
					line: sf.line,
					column: sf.column ?? 1,
					source: sf.source ? new Source(sf.source.name, sf.source.path) : undefined,
				})),
			};
		} catch (err) {
			log.error("stackTrace failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
		}
		this.sendResponse(response);
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		try {
			const body = await this.controller.scopes(args.frameId);
			response.body = { scopes: body?.scopes ?? [] };
		} catch (err) {
			log.error("scopes failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
		}
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		try {
			const body = await this.controller.variables(args.variablesReference, (args as any).filter, (args as any).start, (args as any).count);
			response.body = { variables: body?.variables ?? [] };
		} catch (err) {
			log.error("variables failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
		}
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
		try {
			const body = await this.controller.evaluate(args.expression, args.frameId, (args as any).context);
			response.body = {
				result: body?.result ?? "null",
				variablesReference: body?.variablesReference ?? 0,
			};
		} catch (err) {
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
			response.body = { result: "null", variablesReference: 0 };
		}
		this.sendResponse(response);
	}

	protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments) {
		try {
			const body = await this.controller.setVariable(args.variablesReference, args.name, String(args.value));
			response.body = {
				value: body?.value ?? String(args.value),
				variablesReference: body?.variablesReference ?? 0,
			};
		} catch (err) {
			log.error("setVariable failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
		}
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		log.info("continueRequest (DAP proxy)", args);
		response.body = { allThreadsContinued: true };
		this.controller.cont(args.threadId ?? 0).catch((err) => log.error("editor continue failed", err));
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
		log.info("nextRequest (DAP proxy)", args);
		this.controller.next(args.threadId ?? 0).catch((err) => log.error("editor next failed", err));
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
		log.info("stepInRequest (DAP proxy)", args);
		this.controller.stepIn(args.threadId ?? 0).catch((err) => log.error("editor stepIn failed", err));
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments) {
		log.info("stepOutRequest (DAP proxy, mapped to next)", args);
		this.controller.next(args.threadId ?? 0).catch((err) => log.error("editor next failed", err));
		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments) {
		log.info("pauseRequest (DAP proxy)", args);
		this.controller.pause(args.threadId ?? 0).catch((err) => log.error("editor pause failed", err));
		this.sendResponse(response);
	}

	protected async breakpointLocationsRequest(
		response: DebugProtocol.BreakpointLocationsResponse,
		args: DebugProtocol.BreakpointLocationsArguments,
	) {
		try {
			const sourcePath = (args.source.path ?? "").replace(/\\/g, "/");
			const body = await this.controller.breakpointLocations(sourcePath, args.line, args.endLine);
			response.body = { breakpoints: body?.breakpoints ?? [{ line: args.line }] };
		} catch (err) {
			log.error("breakpointLocations failed", err);
			response.success = false;
			response.message = err instanceof Error ? err.message : String(err);
		}
		this.sendResponse(response);
	}

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments) {
		log.info("terminateRequest (DAP proxy)", args);
		try {
			if (this.mode === "launch") {
				await this.controller.terminate();
			} else {
				await this.controller.disconnect();
			}
		} catch (err) {
			log.error("terminate failed", err);
		}
		this.controller.stop();
		this.sendEvent(new TerminatedEvent());
		this.sendResponse(response);
	}

	protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments) {
		log.info("disconnectRequest (DAP proxy)", args);
		try {
			if (this.mode === "launch" && args.terminateDebuggee !== false) {
				await this.controller.terminate().catch(() => undefined);
			}
			await this.controller.disconnect().catch(() => undefined);
		} finally {
			this.controller.stop();
			this.sendResponse(response);
		}
	}

	// ---- internals ----

	private async initializeEditor(): Promise<void> {
		if (this.editorInitialized) {
			return;
		}
		const initArgs = this.vscodeInitArgs ?? {
			clientID: "vscode",
			adapterID: "godot",
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: "path",
		};
		const body = await this.controller.initialize({
			clientID: (initArgs as any).clientID ?? "vscode",
			clientName: "Godot Tools (VSCode)",
			adapterID: "godot",
			linesStartAt1: initArgs.linesStartAt1 ?? true,
			columnsStartAt1: initArgs.columnsStartAt1 ?? true,
			pathFormat: (initArgs as any).pathFormat ?? "path",
			supportsVariableType: true,
			supportsInvalidatedEvent: true,
			...(initArgs as any).supportsProgressReporting !== undefined
				? { supportsProgressReporting: (initArgs as any).supportsProgressReporting }
				: {},
		});
		log.info("editor initialize ok", body);
		this.editorInitialized = true;
	}

	private async replayBufferedBreakpoints(): Promise<void> {
		if (!this.editorInitialized) {
			return;
		}
		for (const [filePath, lines] of this.bufferedBreakpoints) {
			try {
				await this.controller.setBreakpoints(filePath, lines);
				log.info(`replayed ${lines.length} breakpoints for ${filePath} to editor`);
			} catch (err) {
				log.error(`failed to replay breakpoints for ${filePath}`, err);
			}
		}
	}

	private buildEditorLaunchArgs(args: LaunchRequestArguments): {
		project?: string;
		scene?: string;
		platform?: string;
		playArgs?: string[];
		noDebug?: boolean;
	} {
		// Editor validates `project` is the open project dir.
		const project = args.project?.replace(/\$\{workspaceFolder\}/g, this.resolveWorkspaceFolder());
		const scene = this.controller.resolveSceneArg(args.scene);
		// Editor expects "main"/"current" keywords or a filesystem path.
		// Our pinned/current already resolved to absolute paths above.
		const editorArgs: Record<string, unknown> = {};
		if (project) {
			editorArgs.project = project;
		}
		if (scene) {
			editorArgs.scene = scene;
		}
		editorArgs.platform = "host";
		const playArgs: string[] = [];
		if (args.additional_options) {
			playArgs.push(...args.additional_options.split(" ").filter(Boolean));
		}
		if (playArgs.length > 0) {
			editorArgs.playArgs = playArgs;
		}
		return editorArgs as { project?: string; scene?: string; platform?: string; playArgs?: string[] };
	}

	private resolveWorkspaceFolder(): string {
		return workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	}

	private forwardEditorEvent(event: DapEvent) {
		switch (event.event) {
			case "initialized":
				// Already sent our own InitializedEvent; ignore duplicate.
				break;
			case "process":
				this.sendEvent({ event: "process", body: event.body } as DebugProtocol.ProcessEvent);
				break;
			case "stopped": {
				const body = event.body ?? {};
				const reason: string = body.reason ?? "breakpoint";
				const threadId: number = body.threadId ?? body.thread_id ?? 1;
				if (reason === "breakpoint" && Array.isArray(body.hitBreakpointIds)) {
					this.sendEvent(new StoppedEvent("breakpoint", threadId));
				} else if (reason === "step") {
					this.sendEvent(new StoppedEvent("step", threadId));
				} else if (reason === "exception") {
					this.sendEvent(new StoppedEvent("exception", threadId, body.text ?? body.description ?? "exception"));
				} else if (reason === "paused") {
					this.sendEvent(new StoppedEvent("pause", threadId));
				} else {
					this.sendEvent(new StoppedEvent(reason, threadId, body.text));
				}
				break;
			}
			case "continued": {
				const body = event.body ?? {};
				this.sendEvent(new ContinuedEvent(body.threadId ?? 1, body.allThreadsContinued ?? true));
				break;
			}
			case "terminated":
				this.sendEvent(new TerminatedEvent());
				break;
			case "exited": {
				this.sendEvent(new ExitedEvent(event.body?.exitCode ?? 0));
				break;
			}
			case "output": {
				const body = event.body ?? {};
				const category = body.category === "stderr" ? "stderr" : "stdout";
				this.sendEvent(new OutputEvent(body.output ?? "", category, body.data));
				break;
			}
			case "breakpoint": {
				const body = event.body ?? {};
				this.sendEvent(new BreakpointEvent(body.reason ?? "changed", body.breakpoint ?? {}));
				break;
			}
			case "godot/custom_data":
				log.info("editor custom_data", event.body);
				break;
			default:
				log.info(`unhandled editor event: ${event.event}`, event.body);
				this.sendEvent({ event: event.event, body: event.body } as DebugProtocol.Event);
				break;
		}
	}

	// Legacy shims used by debugger.ts scene tree / inspector views.
	// DAP mode has no scene-tree channel yet; keep views from crashing.
	public async fillInspectorFallback(): Promise<void> {
		window.showWarningMessage("Node Inspector (scene tree) is not yet available in Godot 4 DAP mode.");
	}
}
