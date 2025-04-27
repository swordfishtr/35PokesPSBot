import { styleText } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import { Auth, LogSign, Predicate, PredicateVar, RejectReason } from './globals.js';

interface Listener {
	predicate: Predicate,
	timeoutID: NodeJS.Timeout,
	resolve: (msg: string) => void,
	reject: (msg: string) => void,
	description: string
}

export default class PSBot {

	// #region Constants

	readonly botname: string;
	readonly debug: boolean;

	readonly #ws?: WebSocket;
	readonly ls: Listener[] = [];

	readonly username?: string;

	/** Gets passed every message. Intended to be overwritten. */
	onMessage?: (msg: string) => void;

	/** Called on disconnection. Intended to be overwritten. The bot has to be replaced by a new instance. */
	onDisconnect?: () => void;

	constructor(botname: string, debug: boolean = false) {
		this.botname = botname;
		this.debug = debug;

		this.#closing = this.#_closing.bind(this);
		this.disconnect = this.disconnect.bind(this);
		this.receive = this.receive.bind(this);
		this.receiveNoError = this.receiveNoError.bind(this);
	}

	// #endregion

	// #region Internal use

	#closing: () => void;
	#_closing() {
		this.#ws!.removeEventListener('message', this.receiveNoError);
		while(this.ls.length) {
			const x = this.ls.pop()!;
			clearTimeout(x.timeoutID);
			x.reject(RejectReason.DISCONNECT);
		}
		this.log('Connection closed.');
		if(this.onDisconnect) this.onDisconnect();
	}

	ensureConnected() {
		if(!this.#ws || this.#ws.readyState !== WebSocket.OPEN) throw new Error('Not connected.');
	}

	log(msg: string, sign?: LogSign) {
		if(!this.debug) return;
		const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
		let buf = `${time} :: ${this.botname} `;
		if(this.username) buf += `as ${this.username} `;
		buf += `${sign ?? LogSign.INFO}\n${msg}\n`;
		if(!sign || sign === LogSign.INFO) buf = styleText('green', buf);
		else if(sign === LogSign.OUT) buf = styleText('blue', buf);
		else if(sign === LogSign.WARN) buf = styleText('yellow', buf);
		else if(sign === LogSign.ERR) buf = styleText('red', buf);
		console.log(buf);
	}

	receive(event: MessageEvent) {
		if(typeof event.data !== 'string') throw new TypeError('Message must be a string.');
		if(event.data[0] !== 'a') throw new TypeError(`Message data must be an array: ${event.data}`);
		const messages = JSON.parse(event.data.slice(1));
		if(!Array.isArray(messages)) throw new SyntaxError(`Invalid message data syntax: ${event.data}`);
		for(const msg of messages) {
			this.log(msg, LogSign.IN);
			for(let i = 0; i < this.ls.length; i++) {
				const test = this.ls[i].predicate(msg);
				if(test === null) return;
				else {
					clearTimeout(this.ls[i].timeoutID);
					if(test) this.ls[i].resolve(msg);
					else this.ls[i].reject(msg);
					this.ls.splice(i, 1);
					break;
				}
			}
			if(this.onMessage) this.onMessage(msg);
		}
	}

	/** receive but prettier */
	receiveNoError(event: MessageEvent) {
		try { this.receive(event); }
		catch(err) {
			if(err instanceof TypeError || err instanceof SyntaxError) this.log(`Ignoring a message invalid for reason: ${err.message}`, LogSign.ERR);
			else throw err;
		}
	}

	// #endregion

	// #region External use

	/** Awaits a message satisfying predicate for timeout seconds. */
	await(description: string, timeout: number, predicate: Predicate): Promise<string> {
		this.ensureConnected();
		if(timeout < 5) throw new RangeError('Timeout must be at least 5 seconds.');
		description = `Awaiting ${description}.`;
		return new Promise((resolve, reject) => {
			const timeoutID = setTimeout(() => {
				reject(`${RejectReason.TIMEOUT} ${description}`);
				const i = this.ls.findIndex((x) => x.predicate === predicate);
				// TODO: remove after confirming everything works
				if(i === -1) {
					this.log(`Listener was not removed after resolution: ${description}`, LogSign.ERR);
					return;
				}
				this.ls.splice(i, 1);
				//this.log(`Timed out after ${timeout} seconds: ${description}`, LogSign.WARN);
			}, timeout * 1000);
			this.ls.push({ predicate, timeoutID, resolve, reject, description });
		});
	}

	connect() {
		if(this.#ws) throw new Error('This bot has already been consumed.');
		// @ts-expect-error Readonly-ish
		this.#ws = new WebSocket(PSBot.getURL());
		this.#ws.addEventListener('message', this.receiveNoError);
		this.#ws.addEventListener('error', this.#closing, { once: true });
		this.#ws.addEventListener('close', this.#closing, { once: true });

		return new Promise((resolve, reject) => {
			const timeoutID = setTimeout(() => reject('Failed to connect to websocket.'), 30 * 1000);
			this.#ws!.addEventListener('open', () => {
				clearTimeout(timeoutID);
				resolve(void 0);
				this.log('Connection to websocket established.');
			}, { once: true });
		});
	}

	disconnect() {
		if(!this.#ws) throw new Error('Tried to close before connecting.');
		this.#ws.close();
	}

	async login(auth: Auth) {
		this.ensureConnected();

		const msg1 = await this.await('challstr', 30, this.#CONNECT_1);

		const req1 = await fetch('https://play.pokemonshowdown.com/~~showdown/action.php', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded; encoding=UTF-8' },
			body: new URLSearchParams({ act: 'login', ...auth, challstr: msg1.slice(10) }).toString()
		});
		if(!req1.ok) throw new Error('Could not connect to login server.');
		const res1 = JSON.parse((await req1.text()).slice(1));

		if(!res1.actionsuccess || !res1.curuser.loggedin || res1.assertion.startsWith(';;'))
			throw new Error('Login rejected.');

		this.send(`|/trn ${auth.name},0,${res1.assertion}`);

		await this.await('login confirmation', 30, this.#CONNECT_2(auth.name));

		// @ts-expect-error Readonly-ish
		this.username = auth.name;

		this.log('Login successful.');
	}

	send(msg: string) {
		this.ensureConnected();
		if(msg.includes('\n') && !msg.includes('!code '))
			throw new Error('Newlines without !code are not allowed to be sent.');
		this.log(msg, LogSign.OUT);
		this.#ws!.send(JSON.stringify([msg]));
	}

	// #endregion

	// #region Predicates

	readonly #CONNECT_1: Predicate = (msg) => {
		const data = msg.split('|');
		return data[1] === 'challstr' || null;
	}

	readonly #CONNECT_2: PredicateVar = (val) => (msg) => {
		const data = msg.split('|');
		return data[1] === 'updateuser' && data[2].slice(1) === val || null;
	}

	// #endregion

	static getURL(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789_';

		let rng1 = '';
		while(rng1.length < 8) {
			const i = Math.floor(Math.random() * chars.length);
			rng1 += chars[i];
		}

		const rng2 = Math.floor(Math.random() * 900) + 100;

		return `wss://sim3.psim.us/showdown/${rng1}/${rng2}/websocket`;
	}

}
