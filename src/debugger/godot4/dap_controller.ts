import * as fs from "node:fs";
import { window } from "vscode";
import { createLogger } from "../../utils";
import { pinnedScene } from "../debugger";
import { DapClient, DapEvent } from "./dap_client";
import type { GodotDebugSession } from "./debug_session";

const log = createLogger("debugger.dap_controller", { output: "Godot Debugger" });

export interface DapLaunchArgs {
	project?: string;
	scene?: string;
	platform?: string;
	playArgs?: string[];
	noDebug?: boolean;
}

export type DapAttachArgs = Record<string, never>;

/**
 * DAP controller for Godot 4.
 *
 * Instead of listening for the game (legacy Variant protocol), this connects
 * as a DAP client to the Godot editor's Debug Adapter server
 * (default 127.0.0.1:6006) and proxies VSCode DAP <-> editor DAP.
 *
 * Because breakpoints are sent to the editor BEFORE it spawns the game
 * (via --breakpoints CLI in EditorRun), early breakpoints in
 * _ready/_enter_tree/_init work even when the scene is started from the editor.
 */
export class DapController {
	private client = new DapClient();
	private eventHandler?: (event: DapEvent) => void;

	public constructor(public session: GodotDebugSession) {}

	public onEvent(handler: (event: DapEvent) => void) {
		this.eventHandler = handler;
		this.client.onEvent(handler);
	}

	public get connected(): boolean {
		return this.client.connected;
	}

	private dapHost(args: { address?: string; debugServerAddress?: string }): string {
		return args.debugServerAddress ?? args.address ?? "127.0.0.1";
	}

	private dapPort(args: { port?: number; debugServer?: number }): number {
		// `debugServer` is the editor DAP port (default 6006).
		// `port` is the legacy remote-debug port (default 6007) and is ignored in DAP mode.
		if (typeof args.debugServer === "number") {
			return args.debugServer;
		}
		return 6006;
	}

	public async launch(args: any): Promise<void> {
		const host = this.dapHost(args);
		const port = this.dapPort(args);
		log.info(`Connecting to Godot editor DAP server at ${host}:${port} (launch)`);
		await this.client.connect(host, port);
	}

	public async attach(args: any): Promise<void> {
		const host = this.dapHost(args);
		const port = this.dapPort(args);
		log.info(`Connecting to Godot editor DAP server at ${host}:${port} (attach)`);
		await this.client.connect(host, port);
	}

	public async initialize(args: any): Promise<any> {
		const res = await this.client.sendRequest("initialize", args);
		if (!res.success) {
			throw new Error(`Editor DAP initialize failed: ${res.message ?? JSON.stringify(res.body)}`);
		}
		return res.body;
	}

	public async dapLaunch(args: DapLaunchArgs): Promise<any> {
		const res = await this.client.sendRequest("launch", args);
		if (!res.success) {
			throw new Error(this.formatDapError("launch", res));
		}
		return res.body;
	}

	public async dapAttach(): Promise<any> {
		const res = await this.client.sendRequest("attach", {});
		if (!res.success) {
			throw new Error(this.formatDapError("attach", res));
		}
		return res.body;
	}

	public async configurationDone(): Promise<any> {
		const res = await this.client.sendRequest("configurationDone", {});
		if (!res.success) {
			throw new Error(this.formatDapError("configurationDone", res));
		}
		return res.body;
	}

	public async setBreakpoints(sourcePath: string, lines: number[]): Promise<any[]> {
		const res = await this.client.sendRequest("setBreakpoints", {
			source: { name: sourcePath.split("/").reverse()[0], path: sourcePath },
			breakpoints: lines.map((line) => ({ line })),
			lines,
		});
		if (!res.success) {
			throw new Error(this.formatDapError("setBreakpoints", res));
		}
		return res.body?.breakpoints ?? [];
	}

	public async threads(): Promise<any> {
		const res = await this.client.sendRequest("threads", {});
		if (!res.success) {
			throw new Error(this.formatDapError("threads", res));
		}
		return res.body;
	}

	public async stackTrace(threadId: number, startFrame = 0, levels = 20): Promise<any> {
		const res = await this.client.sendRequest("stackTrace", {
			threadId,
			startFrame,
			levels,
		});
		if (!res.success) {
			throw new Error(this.formatDapError("stackTrace", res));
		}
		return res.body;
	}

	public async scopes(frameId: number): Promise<any> {
		const res = await this.client.sendRequest("scopes", { frameId });
		if (!res.success) {
			throw new Error(this.formatDapError("scopes", res));
		}
		return res.body;
	}

	public async variables(variablesReference: number, filter?: string, start = 0, count?: number): Promise<any> {
		const params: Record<string, unknown> = { variablesReference };
		if (filter) {
			params.filter = filter;
		}
		params.start = start;
		if (count !== undefined) {
			params.count = count;
		}
		const res = await this.client.sendRequest("variables", params);
		if (!res.success) {
			throw new Error(this.formatDapError("variables", res));
		}
		return res.body;
	}

	public async evaluate(expression: string, frameId?: number, context = "hover"): Promise<any> {
		const params: Record<string, unknown> = { expression, context };
		if (frameId !== undefined) {
			params.frameId = frameId;
		}
		const res = await this.client.sendRequest("evaluate", params);
		if (!res.success) {
			throw new Error(this.formatDapError("evaluate", res));
		}
		return res.body;
	}

	public async setVariable(variablesReference: number, name: string, value: string): Promise<any> {
		const res = await this.client.sendRequest("setVariable", { variablesReference, name, value });
		if (!res.success) {
			throw new Error(this.formatDapError("setVariable", res));
		}
		return res.body;
	}

	public async cont(threadId = 0): Promise<any> {
		const res = await this.client.sendRequest("continue", { threadId });
		// Godot notifies `continued` via event; response may have empty body.
		return res.body;
	}

	public async next(threadId = 0): Promise<any> {
		const res = await this.client.sendRequest("next", { threadId });
		return res.body;
	}

	public async stepIn(threadId = 0): Promise<any> {
		const res = await this.client.sendRequest("stepIn", { threadId });
		return res.body;
	}

	public async pause(threadId = 0): Promise<any> {
		const res = await this.client.sendRequest("pause", { threadId });
		return res.body;
	}

	public async terminate(): Promise<any> {
		const res = await this.client.sendRequest("terminate", {});
		return res.body;
	}

	public async disconnect(): Promise<any> {
		try {
			const res = await this.client.sendRequest("disconnect", {});
			return res.body;
		} finally {
			this.client.disconnect();
		}
	}

	public async breakpointLocations(sourcePath: string, line: number, endLine?: number): Promise<any> {
		const params: Record<string, unknown> = { source: { path: sourcePath }, line };
		if (endLine !== undefined) {
			params.endLine = endLine;
		}
		const res = await this.client.sendRequest("breakpointLocations", params);
		if (!res.success) {
			throw new Error(this.formatDapError("breakpointLocations", res));
		}
		return res.body;
	}

	// ---- Compatibility shims for legacy ServerController callers ----
	// Scene tree / inspector use the legacy Variant protocol and are not
	// available over editor DAP. Keep method names so debugger.ts doesn't break.

	public break() {
		this.pause().catch((err) => log.error("DAP pause failed", err));
	}

	public continue() {
		this.cont().catch((err) => log.error("DAP continue failed", err));
	}

	public step() {
		this.stepIn().catch((err) => log.error("DAP stepIn failed", err));
	}

	public step_out() {
		// Editor DAP has no stepOut; fall back to next.
		this.next().catch((err) => log.error("DAP next (step_out) failed", err));
	}

	public set_breakpoint(_path_to: string, _line: number) {
		// Breakpoints are synced via setBreakpointsRequest, not one-by-one.
		log.warn("DAP set_breakpoint single-shot is a no-op; breakpoints sync via setBreakpoints");
	}

	public remove_breakpoint(_path_to: string, _line: number) {
		log.warn("DAP remove_breakpoint single-shot is a no-op; breakpoints sync via setBreakpoints");
	}

	public request_inspect_object(_object_id: bigint) {
		log.warn("Scene inspector is not available over editor DAP (legacy protocol only)");
	}

	public request_scene_tree() {
		log.warn("Scene tree is not available over editor DAP (legacy protocol only)");
	}

	public request_stack_dump() {
		// Stack is pulled via stackTraceRequest on stopped events.
	}

	public request_stack_frame_vars(_frame_id: number) {
		// Scopes/variables are pulled via scopes/variables requests.
	}

	public set_object_property(_objectId: bigint, _label: string, _value: unknown) {
		log.warn("set_object_property is not available over editor DAP; use setVariable in Variables view");
	}

	public set_exception(_exception: string) {
		// Handled via stopped event reason.
	}

	private formatDapError(command: string, res: { message?: string; body?: any }): string {
		const body = res.body?.error;
		if (body?.format) {
			let text = body.format as string;
			const vars = body.variables ?? {};
			for (const [k, v] of Object.entries(vars)) {
				text = text.replace(`{${k}}`, String(v));
			}
			return `Editor DAP ${command} failed: ${res.message ?? ""} ${text}`.trim();
		}
		return `Editor DAP ${command} failed: ${res.message ?? JSON.stringify(res.body)}`;
	}

	public stop() {
		log.info("Stopping DAP controller");
		this.client.disconnect();
	}

	public abort() {
		this.stop();
	}

	/** Resolve `scene` launch option to an editor-compatible scene value. */
	public resolveSceneArg(scene: string | undefined): string {
		if (!scene || scene === "main") {
			return "main";
		}
		if (scene === "current") {
			const activePath = window.activeTextEditor?.document.fileName;
			if (activePath) {
				if (activePath.endsWith(".gd")) {
					const scenePath = activePath.replace(/\.gd$/, ".tscn");
					if (fs.existsSync(scenePath)) {
						return scenePath;
					}
				} else {
					return activePath;
				}
			}
			return "current";
		}
		if (scene === "pinned") {
			if (pinnedScene) {
				const p = pinnedScene.fsPath;
				if (p.endsWith(".gd")) {
					const scenePath = p.replace(/\.gd$/, ".tscn");
					if (fs.existsSync(scenePath)) {
						return scenePath;
					}
				}
				return p;
			}
			return "main";
		}
		return scene;
	}
}
