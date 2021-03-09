import { Socket, createConnection, isIP } from 'net';
import * as log from './log';
import Queue from "promise-queue";

export class TcpSocket {
	private ipAddress: string;
	private port: number;
	private socket?: Socket;
	private nextMessage?: Buffer;
	connected: boolean;
	private interval: NodeJS.Timeout;
	private connectionChangedHandler: (connected: boolean) => void;

	// serialize socket requests
	private queue = new Queue(1, Infinity);

	constructor(ipAddress: string, port: number, connectionChangedHandler: (connected: boolean) => void) {
		this.ipAddress = ipAddress;
		this.port = port;
		this.connected = false;
		this.connectionChangedHandler = connected => {
			this.connected = connected;
			connectionChangedHandler(connected);
		};
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.connected) {
				return resolve();
			}

			log.verbose('TcpSocket.connect', `Connecting to ${this.ipAddress}`);

			let connectPromiseResolved = false;

			this.socket = createConnection({
				port: this.port,
				host: this.ipAddress,
				family: isIP(this.ipAddress)
			}, () => {
				this.connectionChangedHandler(true);
				connectPromiseResolved = true;

				resolve();
			});

			this.socket.on('data', data => {
				this.nextMessage = data;
			});

			this.socket.on('error', error => {
				if (connectPromiseResolved) {
					log.error('Socket Error:', error.message || error);
				}
			});

			this.socket.on('close', hadError => {
				let baseMessage = `Socket closed${hadError ? ' (with error)' : ''}`;

				if (connectPromiseResolved) {
					log.warn(baseMessage);
				} else {
					log.warn(`${baseMessage} during connection process - not attempting restart`);

					reject(new Error('Unable to connect to device. Are you on the same WiFi network?'));
				}

				this.connectionChangedHandler(false);
			});

			this.socket.on('timeout', () => {
				log.warn('Socket timeout');
			});
		});
	}

	async disconnect(): Promise<void> {
		await new Promise<void>(resolve => {
			if (this.connected && this.socket) {
				this.socket.end(resolve);
			} else {
				resolve();
			}
		});
	}

	async send(message: Buffer): Promise<void> {
		await new Promise((resolve, reject) => {
			if (this.socket) {
				this.socket.write(message, resolve);
			} else {
				reject(new Error('Socket isn\'t running, please call connect()'));
			}
		});
	}

	async sendWaitForResponse(message: Buffer): Promise<Buffer> {
		return this.queue.add(async () => {
			await this.send(message);

			return new Promise(async (resolve, reject) => {
				this.nextMessage = undefined;

				const timeout = 10000;
				const intervalTime = 10;

				let attempts = 0;
				let interval = setInterval(() => {
					if (this.interval != null) clearTimeout(this.interval);

					if (this.nextMessage) {
						clearInterval(interval);

						resolve(this.nextMessage);
					} else if (!this.connected) {
						clearInterval(interval);

						reject(new Error('Socket closed without sending response'));
					} else if (attempts++ > timeout / intervalTime) {
						clearInterval(interval);

						reject(new Error('Response timeout exceeded'));
					}
				}, 10);
			});
		});
	}
}
