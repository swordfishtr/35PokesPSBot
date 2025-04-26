import { styleText } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import { PSBot } from './PSBot.js';
import PokemonShowdown from '../../pokemon-showdown/dist/sim/index.js';
const { Dex, Teams, TeamValidator, toID } = PokemonShowdown;
import { Auth, LogSign, Predicate, PredicateVar, RejectReason } from './globals.js';

interface Battle {
	format: string,
	side1: BattleSide,
	side2: BattleSide
}

interface BattleSide {
	team: string,
	username: string
}

// this assumes everything (like showdown, metaindex, config.json) is set up, which the controller will ensure.
// if either bot disconnects, things like challenging can get stuck so we should start over until a more efficient solution is found.
export class BattleFactory {

	// zero-based, determined by Controller
	readonly authSlots: [number, number];
	readonly debug: boolean;

	disconnections: number = 0;

	readonly queue: string[] = [];
	readonly queueBan: string[] = [];
	readonly #queueInterval: NodeJS.Timeout;
	readonly challenges: { [k: string]: string } = {};

	// @ts-expect-error
	bot1: PSBot;
	// @ts-expect-error
	bot2: PSBot;

	// factory-sets.json
	factoryFormats: any;

	factoryGenerator: any;

	factoryValidator: any;

	readonly chalcode = 'gen9nationaldex35pokes@@@+allpokemon,+unobtainable,+past,+shedtail,+tangledfeet';

	constructor(authSlots: [number, number], debug?: boolean) {
		const formatBattleFactory = Dex.formats.get('gen9battlefactory');
		this.factoryGenerator = Teams.getGenerator(formatBattleFactory);

		const format35Pokes = Dex.formats.get(this.chalcode);
		this.factoryValidator = new TeamValidator(format35Pokes);

		this.authSlots = authSlots;
		this.debug = debug ?? false;
		this.receive = this.receive.bind(this);
		this.newBots = this.newBots.bind(this);
		this.shutdown = this.shutdown.bind(this);
		this.tryMatchmaking = this.tryMatchmaking.bind(this);
		this.prepBattle = this.prepBattle.bind(this);
		this.genBattle = this.genBattle.bind(this);

		this.newBots();
		this.#queueInterval = setInterval(this.tryMatchmaking, 5 * 1000);
	}

	newBots() {
		// This is the only place where the bots can be undefined.
		if(this.bot1 && this.bot2) {
			this.disconnections++;

			delete this.bot1.onDisconnect;
			delete this.bot2.onDisconnect;

			this.bot1.disconnect();
			this.bot2.disconnect();
		}

		if(this.disconnections > 2) {
			this.shutdown();
			throw new Error('This instance of BattleFactory has disconnected too many times, refusing to continue.');
		}

		this.bot1 = new PSBot('Primary Bot', this.debug);
		this.bot2 = new PSBot('Secondary Bot', this.debug);

		this.bot1.onDisconnect = this.newBots;
		this.bot2.onDisconnect = this.newBots;

		this.bot1.onMessage = this.receive;

		const { logins } = require('../config.json');
		
		return this.bot1.connect()
		.then(() => this.bot1.login(logins[this.authSlots[0]]))
		.then(() => this.bot2.connect())
		.then(() => this.bot2.login(logins[this.authSlots[1]]));
	}

	tryMatchmaking() {
		if(this.queue.length < 2) return;

		const [user1, user2] = this.queue.splice(0, 2);
		this.queueBan.push(user1, user2);
		this.prepBattle(user1, user2).then(this.genBattle).finally(() => {
			const i1 = this.queueBan.indexOf(user1);
			if(i1 !== -1) this.queueBan.splice(i1, 1);
			const i2 = this.queueBan.indexOf(user2);
			if(i2 !== -1) this.queueBan.splice(i2, 1);
		});
	}

	shutdown() {
		delete this.bot1.onDisconnect;
		delete this.bot2.onDisconnect;

		this.bot1.disconnect();
		this.bot2.disconnect();

		clearInterval(this.#queueInterval);
		if(this.onShutdown) this.onShutdown();
	}

	onShutdown?: () => void;

	log(msg: string, sign: Extract<LogSign, LogSign.ERR | LogSign.INFO | LogSign.WARN>) {
		if(!this.debug) return;
		const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
		let buf = `${time} :: ${msg}\n`;
		if(sign === LogSign.INFO) buf = styleText(['green', 'bold'], buf);
		else if(sign === LogSign.WARN) buf = styleText(['yellow', 'bold'], buf);
		else buf = styleText(['red', 'bold'], buf);
		console.log(buf);
	}

	prepBattle(user1: string, user2: string, format?: string): Promise<Battle> {
		user1 = toID(user1);
		user2 = toID(user2);
		const battle = {
			side1: { username: user1 },
			side2: { username: user2 },
			format
		} as Battle;

		this.log(`Attempting to prepare a battle for ${user1} and ${user2}`, LogSign.INFO)
		this.bot1.send(`|/cmd userdetails ${user1}`);
		this.bot2.send(`|/cmd userdetails ${user2}`);

		return Promise.all([
			this.bot1.await(`userdetails ${user1}`, 30, this.#BATTLE_1(user1)),
			this.bot2.await(`userdetails ${user2}`, 30, this.#BATTLE_1(user2)),
		])
		.catch((err) => {
			if(typeof err !== 'string' || Object.values(RejectReason).includes(err as RejectReason)) throw err;
			// Offline user, remove them from queue.
			const id = /"userid":"(.+?)"/.exec(err)![1];
			const i = this.queue.indexOf(id);
			if(i !== -1) this.queue.splice(i, 1);
			throw err;
		})
		.then(() => {
			if(!battle.format) {
				const formats = Object.keys(this.factoryFormats);
				battle.format = formats[Math.floor(Math.random() * formats.length)];
			}
			this.factoryGenerator.factoryTier = battle.format;

			const team1 = this.factoryGenerator.getTeam();
			const problems1 = this.factoryValidator.baseValidateTeam(team1);
			if(problems1?.length) throw new Error(JSON.stringify(problems1));
			battle.side1.team = Teams.pack(team1);

			const team2 = this.factoryGenerator.getTeam();
			const problems2 = this.factoryValidator.baseValidateTeam(team2);
			if(problems2?.length) throw new Error(JSON.stringify(problems2));
			battle.side2.team = Teams.pack(team2);

			return battle;
		})
	}

	genBattle(battle: Battle) {
		// No response for these.
		this.bot1.send(`|/utm ${battle.side1.team}`);
		this.bot2.send(`|/utm ${battle.side2.team}`);

		this.bot1.send(`|/challenge ${this.bot2.username}, ${this.chalcode}`);
		return this.bot2.await('challenge', 30, this.#BATTLE_2)
		.then(() => {
			this.bot2.send(`|/accept ${this.bot1.username}`);
			return this.bot1.await('battle room', 30, this.#BATTLE_3);
		})
		.then((msg) => {
			const room = msg.slice(1, msg.indexOf('\n'));

			// Could process further.
			if(battle.format.endsWith('.txt')) battle.format = battle.format.slice(0, -4);

			this.bot1.send(`${room}|35 Factory Format: ${battle.format}`);
			this.bot1.send(`${room}|/timer on`);
			this.bot2.send(`${room}|/timer on`);
			this.bot1.send(`${room}|/leavebattle`);
			this.bot2.send(`${room}|/leavebattle`);
			this.bot1.send(`${room}|/addplayer ${battle.side1.username}, p1`);
			this.bot2.send(`${room}|/addplayer ${battle.side2.username}, p2`);
			this.bot2.send(`|/noreply /leave ${room}`);

			this.log(`Started a ${battle.format} battle for ${battle.side1.username} and ${battle.side2.username} at ${room}`, LogSign.INFO);

			return this.bot1.await('battle end', 60 * 60, this.#BATTLE_4(room));
		})
		.then((msg) => {
			const room = msg.slice(1, msg.indexOf('\n'));
			this.bot1.send(`|/noreply /leave ${room}`);

			this.log(`Battle ended at ${room}`, LogSign.INFO);

			return this.bot1.await('battle exit', 30, this.#BATTLE_5(room));
		});
	}

	loadFactory() {
		this.factoryFormats = require('../../35PokesIndex/factory-sets.json');
	}

	receive(msg: string) {
		// check predicates here for set query, 'in' dm etc.
		if(this.#BOTCMD_1(msg)) return this.respondPM(msg);
		if(this.#BOTCMD_2(msg)) return this.respondBR(msg);
	}

	//|/pm demirab2, asd
	respondPM(msg: string) {
		const data = msg.split('|', 5);
		const user = toID(data[2].slice(1));
		const fields = data[4].split(' ').map(toID);

		const out = this.runCommand(user, fields);
		if(out) this.bot1.send(`|/pm ${user}, ${out}`);
	}

	respondBR(msg: string) {
		const data = msg.split('|', 4);
		const room = data[0].slice(1, -1);
		const user = toID(data[2].slice(1));
		const fields = data[3].slice(1).split(' ').map(toID);

		const out = this.runCommand(user, fields);
		if(out) this.bot1.send(`${room}|${out}`);
	}

	runCommand(user: string, fields: string[]): string {
		switch(fields[0]) {
			case 'in':
			case 'can': {
				if(this.queue.includes(user)) return 'You are already in the matchmaking queue.';
				if(this.queueBan.includes(user)) return 'You can not enter the matchmaking queue at the moment.'
				this.queue.push(user);
				return 'You have entered the matchmaking queue.';
			}
			case 'out':
			case 'leave':
			case 'exit': {
				const i = this.queue.indexOf(user);
				if(i === -1) return 'You are not in the matchmaking queue.'
				this.queue.splice(i, 1);
				return 'You have exited the matchmaking queue.';
			}
			case 'chal':
			case 'challenge': {
				// matchmake if target in challenges, otherwise add user to challenges
				return 'To be implemented.';
			}
			case 'unchal':
			case 'unchallenge': {
				// delete challenge
				return 'To be implemented.';
			}
			case 'bf':
			case 'set':
			case 'sets': {
				// set info
				return 'To be implemented.';
			}
			default: return 'Commands (prefix ; in battle rooms): ' +
			'```in```: Find match. ' +
			'```out```: Exit queue. ' +
			'```chal``` ```user``` ```format?```: Challenge (chal back to accept). ' +
			'```unchal```: Withdraw challenge. ' +
			'```bf``` ```species``` ```format```: Query factory sets. ';
		}
	}

	readonly #BATTLE_1: PredicateVar = (val) => (msg) => {
		const data = msg.split('|', 4);
		if(data[1] !== 'queryresponse' || data[2] !== 'userdetails') return null;
		const details = JSON.parse(data[3]);
		if(details.userid !== val) return null;
		return !!details.rooms;
	}

	readonly #BATTLE_2: Predicate = (msg) => {
		const data = msg.split('|', 5);
		return data[1] === 'pm' &&
		data[2]?.slice(1) === this.bot1.username &&
		data[3]?.slice(1) === this.bot2.username &&
		data[4]?.startsWith(`/challenge ${this.chalcode}`) ||
		null;
	}

	readonly #BATTLE_3: Predicate = (msg) => {
		const data = msg.split('\n', 3).map((x) => x.split('|', 3));
		return data[0][0].startsWith('>battle-gen9nationaldex35pokes-') &&
		data[1]?.[1] === 'init' &&
		data[1]?.[2] === 'battle' &&
		data[2]?.[1] === 'title' &&
		data[2]?.[2] === `${this.bot1.username} vs. ${this.bot2.username}` ||
		null;
	}

	readonly #BATTLE_4: PredicateVar = (val) => (msg) => {
		const data = msg.split('\n').map((x) => x.split('|', 2));
		return data[0][0].slice(1) === val &&
		data.pop()?.[1] === 'win' ||
		null;
	}

	readonly #BATTLE_5: PredicateVar = (val) => (msg) => {
		const data = msg.split('\n', 2).map((x) => x.split('|', 2));
		return data[0][0].slice(1) === val &&
		data[1]?.[1] === 'deinit' ||
		null;
	}

	// pm
	readonly #BOTCMD_1: Predicate = (msg) => {
		const data = msg.split('|', 4);
		return data[0] === '' &&
		data[1] === 'pm' &&
		// The sender must be anyone except our bots; the recipient must be our main bot.
		![this.bot1.username, this.bot2.username].includes(data[2]?.slice(1)) &&
		data[3]?.slice(1) === this.bot1.username ||
		null;
	}

	// battle room
	readonly #BOTCMD_2: Predicate = (msg) => {
		const data = msg.split('\n', 2).map((x) => x.split('|', 4));
		return data[1]?.[0] === '' &&
		data[1]?.[1] === 'c' &&
		// Bot command prefix in battle rooms
		data[1]?.[3]?.[0] === ';' ||
		null;
	}

}
