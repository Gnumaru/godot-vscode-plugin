import * as net from "node:net";
import { createLogger } from "../../utils";

const log = createLogger("debugger.dap_client", { output: "Godot Debugger" });

export interface DapResponse {
	seq: number;
	type: "response";
	request_seq: number;
	command: string;
	success: boolean;
	message?: string;
	body?: any;
}

export interface DapEvent {
	seq: number;
	type: "event";
	event: string;
	body?: any;
}

type DapMessage = DapResponse | DapEvent | { seq: number; type: string; [k: string]: any };

interface PendingRequest {
	command: string;
	resolve: (res: DapResponse) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * Minimal DAP client speaking to Godot editor's Debug Adapter server
 * (editor/debugger/debug_adapter, default port 6006).
 *
 * Wire format: `Content-Length: <n>\r\n\r\n<json>` per message.
 */
export class DapClient {
	private socket?: net.Socket;
	private seq = 0;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, PendingRequest>();
	private eventHandlers: ((event: DapEvent) => void)[] = [];

	public onEvent(handler: (event: DapEvent) => void) {
		this.eventHandlers.push(handler);
	}

	public get connected(): boolean {
		return !!this.socket && !this.socket.destroyed;
	}

	public async connect(host: string, port: number, timeoutMs = 10000): Promise<void> {
		if (this.connected) {
			return;
		}
		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ host, port }, () => {
				log.info(`Connected to Godot editor DAP server at ${host}:${port}`);
				this.socket = socket;
				this.setupSocket(socket);
				resolve();
			});
			const timer = setTimeout(() => {
				socket.destroy();
				reject(
					new Error(
						`Timed out connecting to Godot editor DAP server at ${host}:${port}. Is the Godot editor running with the project open? (Editor Settings > Network > Debug Adapter > Remote Port)`,
					),
				);
			}, timeoutMs);
			socket.on("error", (err) => {
				clearTimeout(timer);
				reject(
					new Error(
						`Cannot connect to Godot editor DAP server at ${host}:${port}: ${err.message}. Is the Godot editor running with the project open?`,
					),
				);
			});
			socket.on("connect", () => clearTimeout(timer));
		});
	}

	private setupSocket(socket: net.Socket) {
		socket.on("data", (data: Buffer) => this.onData(data));
		socket.on("close", () => {
			log.info("DAP connection closed");
			this.failAllPending(new Error("DAP connection closed"));
			this.socket = undefined;
			this.buffer = Buffer.alloc(0);
		});
		socket.on("error", (err) => {
			log.error("DAP socket error", err);
		});
	}

	private failAllPending(err: Error) {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.pending.clear();
	}

	private onData(data: Buffer) {
		this.buffer = Buffer.concat([this.buffer, data]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			const header = this.buffer.subarray(0, headerEnd).toString("utf8");
			const match = header.match(/Content-Length:\s*(\d+)/i);
			if (!match) {
				log.error(`Invalid DAP header: ${header}`);
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const contentLength = Number.parseInt(match[1], 10);
			const totalLength = headerEnd + 4 + contentLength;
			if (this.buffer.length < totalLength) {
				return; // wait for more data
			}
			const content = this.buffer.subarray(headerEnd + 4, totalLength).toString("utf8");
			this.buffer = this.buffer.subarray(totalLength);
			try {
				const message = JSON.parse(content) as DapMessage;
				this.onMessage(message);
			} catch (err) {
				log.error("Failed to parse DAP message", err, content.slice(0, 500));
			}
		}
	}

	private onMessage(message: DapMessage) {
		if (message.type === "response") {
			const res = message as DapResponse;
			const pending = this.pending.get(res.request_seq);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(res.request_seq);
				pending.resolve(res);
			} else {
				log.warn(`Received DAP response for unknown request_seq ${res.request_seq}`);
			}
		} else if (message.type === "event") {
			const event = message as DapEvent;
			for (const handler of this.eventHandlers) {
				try {
					handler(event);
				} catch (err) {
					log.error("DAP event handler failed", err);
				}
			}
		} else {
			log.warn(`Received unknown DAP message type: ${(message as any).type}`);
		}
	}

	public sendRequest(command: string, args?: any, timeoutMs = 15000): Promise<DapResponse> {
		if (!this.socket) {
			return Promise.reject(new Error("Not connected to Godot editor DAP server"));
		}
		const seq = ++this.seq;
		const message: Record<string, unknown> = {
			seq,
			type: "request",
			command,
			arguments: args ?? {},
		};
		const json = JSON.stringify(message);
		const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`DAP request '${command}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(seq, { command, resolve, reject, timer });
			this.socket?.write(payload, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(seq);
					reject(err);
				}
			});
		});
	}

	public disconnect() {
		this.failAllPending(new Error("DAP client disconnected"));
		this.socket?.destroy();
		this.socket = undefined;
		this.buffer = Buffer.alloc(0);
	}
}
