/**
 * Battle Factory service
 * 
 * Configuration details:
 * tbd
 */

import { styleText } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import PSBot from './PSBot.js';
import PokemonShowdown from '../../pokemon-showdown/dist/sim/index.js';
const { Dex, Teams, TeamValidator, toID } = PokemonShowdown;
import { Auth, FactorySet, importJSON, LogSign, PATH_CONFIG, PATH_PS_FACTORYSETS, Predicate, PredicateVar, RejectReason, State } from './globals.js';

interface Battle {
	format: string,
	chalcode: string,
	isRandom: boolean,
	side1: BattleSide,
	side2: BattleSide
}

interface BattleSide {
	team: string,
	username: string
}

// TODO: fill out empty errors.

// Ubers support requires a patch to dist/data/random-battles/gen9/teams.js
// - species: typeof species.battleOnly === "string" ? species.battleOnly : species.name,
// + species: species.name,

export default class BattleFactory {

	#state: State = State.NEW;
	get state() { return this.#state; }

	debug: boolean = false;
	readonly sudoers: string[] = [];

	readonly queue: string[] = [];
	readonly queueBan: string[] = [];
	#queueInterval?: NodeJS.Timeout;

	readonly challenges: { [k: string]: string } = {};

	bot1?: PSBot;
	bot2?: PSBot;

	// factory-sets.json
	factorySets: any;

	factoryGenerator: any;

	factoryValidator: any;
	factoryValidatorUbers: any;

	readonly teamErrors: string[] = [];

	readonly chalcode = 'gen9nationaldex35pokes@@@+allpokemon,+unobtainable,+past,+shedtail,+tangledfeet';
	readonly chalcodeUbers = 'gen9nationaldex35pokes@@@!obtainableformes,!evasionabilitiesclause,!drypassclause,batonpassclause,-allpokemon,+unobtainable,+past,-nduber,-ndag,-ndou,-nduubl,-nduu,-ndrubl,-ndru,-ndnfe,-ndlc,+forretress,+samurott-hisui,+kyurem-white,+glalie-base,+cresselia,+thundurus-base,+regidrago,+banette-mega,+banettite,+dialga-origin,+giratina-origin,+palkia-base,+arceus-rock,+lunala,+machamp,+manectric-mega,+manectite,+naganadel,+pincurchin,+meloetta-pirouette,+blissey,+alakazam-mega,+alakazite,+aggron-mega,+aggronite,+ogerpon-hearthflame-tera,+hoopa-unbound,+dragapult,+camerupt-mega,+cameruptite,+tyranitar-mega,+tyranitarite,+gothitelle,+skarmory,+deoxys-speed,+floette-eternal,+gastrodon,+dhelmise,+sceptile-mega,+sceptilite,+irontreads,+victini,-darkvoid,-grasswhistle,-hypnosis,-lovelykiss,-sing,-sleeppowder,+lastrespects,+moody,+shadowtag,+battlebond,+powerconstruct,+acupressure,+batonpass+contrary,+batonpass+rapidspin,+shedtail,+tangledfeet';

	onShutdown?: () => void;

	constructor() {
		const formatBattleFactory = Dex.formats.get('gen9battlefactory');
		this.factoryGenerator = Teams.getGenerator(formatBattleFactory);

		const format35Pokes = Dex.formats.get(this.chalcode);
		const format35PokesUbers = Dex.formats.get(this.chalcodeUbers);
		this.factoryValidator = new TeamValidator(format35Pokes);
		this.factoryValidatorUbers = new TeamValidator(format35PokesUbers);

		this.receive = this.receive.bind(this);
		this.init = this.init.bind(this);
		this.connect = this.connect.bind(this);
		this.shutdown = this.shutdown.bind(this);
		this.tryMatchmaking = this.tryMatchmaking.bind(this);
		this.prepBattle = this.prepBattle.bind(this);
		this.genBattle = this.genBattle.bind(this);
	}

	init() {
		if(this.#state !== State.NEW) throw new Error();
		this.loadConfig();
		this.#state = State.INIT;
	}

	loadConfig() {
		this.factorySets = importJSON(PATH_PS_FACTORYSETS);
		const { debug, sudoers } = importJSON(PATH_CONFIG).battleFactory;
		this.debug = !!debug;
		this.sudoers.length = 0;
		this.sudoers.push(...sudoers);
	}

	async connect() {
		if(this.#state !== State.INIT) throw new Error();

		this.bot1 = new PSBot('35 Factory Primary Bot', this.debug);
		this.bot2 = new PSBot('35 Factory Secondary Bot', this.debug);

		this.bot1.onDisconnect = this.shutdown;
		this.bot2.onDisconnect = this.shutdown;

		const { botAuth1, botAuth2, interval } = importJSON(PATH_CONFIG).battleFactory;

		try {
			await this.bot1.connect();
			await this.bot1.login(botAuth1 as Auth);
			await this.bot2.connect();
			await this.bot2.login(botAuth2 as Auth);
			this.#state = State.ON;
			this.#queueInterval = setInterval(this.tryMatchmaking, (interval || 5) * 1000);
			this.bot1.onMessage = this.receive;
		}
		catch(err) {
			this.#state = State.OFF;
			throw err;
		}
	}

	shutdown() {
		if(this.#state !== State.ON) throw new Error();

		delete this.bot1!.onDisconnect;
		delete this.bot2!.onDisconnect;

		this.bot1!.disconnect();
		this.bot2!.disconnect();

		clearInterval(this.#queueInterval);
		if(this.onShutdown) this.onShutdown();

		this.#state = State.OFF;
	}

	async tryMatchmaking() {
		if(this.#state !== State.ON) throw new Error();
		if(this.queue.length < 2) return;

		const players = this.queue.slice(0, 2);
		let battle: Battle | undefined;

		// Making sure both sides are online.
		try {
			battle = await this.prepBattle(players[0], players[1]);
		}
		catch(err) {
			if(typeof err !== 'string' || Object.values(RejectReason).includes(err as RejectReason)) throw err;
			// Offline user, remove them from queue.
			for(const player of players) {
				if(err.includes(`"userid":"${player}"`)) {
					const i = this.queue.indexOf(player);
					this.queue.splice(i, 1);
					break;
				}
			}
		}
		if(!battle) return;

		// To prevent matchmaking spam, players are only allowed to be in 1 game at a time.
		this.queueBan.push(...players);
		for(const player of players) {
			const i = this.queue.indexOf(player);
			if(i !== -1) this.queue.splice(i, 1);
		}

		// Goes on until the battle ends. If this throws, the bot is to stop.
		await this.genBattle(battle);

		for(const player of players) {
			const i = this.queueBan.indexOf(player);
			if(i !== -1) this.queueBan.splice(i, 1);
		}
	}

	log(msg: string, sign: Extract<LogSign, LogSign.ERR | LogSign.INFO | LogSign.WARN>) {
		if(!this.debug) return;
		const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
		let buf = `${time} :: ${msg}\n`;
		if(sign === LogSign.INFO) buf = styleText(['green', 'bold'], buf);
		else if(sign === LogSign.WARN) buf = styleText(['yellow', 'bold'], buf);
		else buf = styleText(['red', 'bold'], buf);
		console.log(buf);
	}

	/** Dump debugging data. */
	dump(): string {
		let buf = 'Battle Factory Dump\n';
		buf += `state: ${this.#state}\n`;
		buf += `sudoers: ${this.sudoers.join(', ')}\n`
		buf += `queue: ${this.queue.join(', ')}\n`;
		buf += `queueBan: ${this.queueBan.join(', ')}\n`;
		buf += `challenges: ${Object.entries(this.challenges).map((x) => `${x[0]} to ${x[1]}`).join(', ')}\n`;
		buf += `factorySets: ${this.factorySets ? 'loaded' : 'missing'}\n`;
		buf += `factoryGenerator: ${this.factoryGenerator ? 'loaded' : 'missing'}\n`;
		buf += `factoryValidator: ${this.factoryValidator ? 'loaded' : 'missing'}\n`;
		buf += `bot1 listeners: ${this.bot1?.ls.map((x) => x.description).join(', ')}\n`;
		buf += `bot2 listeners: ${this.bot2?.ls.map((x) => x.description).join(', ')}\n`;
		buf += `teamErrors: ${this.teamErrors.join(';\n')}`;
		return buf;
	}

	prepBattle(user1: string, user2: string, format?: string): Promise<Battle> {
		if(this.#state !== State.ON) throw new Error();

		user1 = toID(user1);
		user2 = toID(user2);
		const battle = {
			side1: { username: user1 },
			side2: { username: user2 },
			format
		} as Battle;

		this.log(`Preparing a battle for ${user1} and ${user2}`, LogSign.INFO)
		this.bot1!.send(`|/cmd userdetails ${user1}`);
		this.bot2!.send(`|/cmd userdetails ${user2}`);

		return Promise.all([
			this.bot1!.await(`userdetails ${user1}`, 30, this.#BATTLE_1(user1)),
			this.bot2!.await(`userdetails ${user2}`, 30, this.#BATTLE_1(user2)),
		])
		.then(() => {
			if(!battle.format) {
				const formats = Object.keys(this.factorySets);
				battle.format = formats[Math.floor(Math.random() * formats.length)];
			}
			this.factoryGenerator.factoryTier = battle.format;
			battle.isRandom = !format;
			let validator: any;

			if(battle.format === 'Uber' || battle.format.startsWith('Seniors/')) {
				battle.chalcode = this.chalcodeUbers;
				validator = this.factoryValidatorUbers;
			}
			//else if(battle.format.startsWith('Perfect/')) { if not A1 or A2 }
			else {
				battle.chalcode = this.chalcode;
				validator = this.factoryValidator;
			}

			console.log(battle.chalcode);

			const teams: any[] = [];
			while(teams.length < 2) {
				const team = this.factoryGenerator.getTeam();
				const problems: string[] | null = validator.baseValidateTeam(team);
				if(problems?.length) {
					this.teamErrors.push(problems.join(', '));
					// hardcode max 20 errors
					if(this.teamErrors.length >= 20) throw new Error(`Too many validator errors:\n${this.teamErrors.join(';\n')}`);
					continue;
				}
				teams.push(team);
			}
			battle.side1.team = Teams.pack(teams[0]);
			battle.side2.team = Teams.pack(teams[1]);

			return battle;
		})
	}

	genBattle(battle: Battle) {
		if(this.#state !== State.ON) throw new Error();

		// No response for these.
		this.bot1!.send(`|/utm ${battle.side1.team}`);
		this.bot2!.send(`|/utm ${battle.side2.team}`);

		this.bot1!.send(`|/challenge ${this.bot2!.username}, ${battle.chalcode}`);
		return this.bot2!.await('challenge', 30, this.#BATTLE_2(battle.chalcode))
		.then(() => {
			this.bot2!.send(`|/accept ${this.bot1!.username}`);
			return this.bot1!.await('battle room', 30, this.#BATTLE_3);
		})
		.then((msg) => {
			const room = msg.slice(1, msg.indexOf('\n'));

			// Could process further.
			if(battle.format.endsWith('.txt')) battle.format = battle.format.slice(0, -4);
			if(!battle.isRandom) battle.format += ' (user-selected)';

			this.bot1!.send(`${room}|35 Factory Format: ${battle.format}`);
			this.bot1!.send(`${room}|/timer on`);
			this.bot2!.send(`${room}|/timer on`);
			this.bot1!.send(`${room}|/leavebattle`);
			this.bot2!.send(`${room}|/leavebattle`);
			this.bot1!.send(`${room}|/addplayer ${battle.side1.username}, p1`);
			this.bot2!.send(`${room}|/addplayer ${battle.side2.username}, p2`);
			this.bot2!.send(`|/noreply /leave ${room}`);

			this.log(`Started a ${battle.format} battle for ${battle.side1.username} and ${battle.side2.username} at ${room}`, LogSign.INFO);

			return this.bot1!.await('battle end', 60 * 60, this.#BATTLE_4(room));
		})
		.then((msg) => {
			const room = msg.slice(1, msg.indexOf('\n'));
			this.bot1!.send(`|/noreply /leave ${room}`);

			this.log(`Battle ended at ${room}`, LogSign.INFO);

			return this.bot1!.await('battle exit', 30, this.#BATTLE_5(room));
		});
	}

	receive(msg: string) {
		if(this.#state !== State.ON) throw new Error();
		if(this.#BOTCMD_1(msg)) return this.#respondPM(msg);
		if(this.#BOTCMD_2(msg)) return this.#respondBR(msg);
	}

	#respondPM(msg: string) {
		const data = msg.split('|', 5);
		const user = toID(data[2].slice(1));
		const fields = data[4].split(' ');

		const out = this.runCommand(user, ...fields);
		if(!out) return;

		const outLines = out.split('\n');
		if(outLines.length === 1) this.bot1!.send(`|/pm ${user}, ${out}`);

		else {
			outLines[0] = `!code ${outLines[0]}`;
			const outCode = outLines.map((x) => `/pm ${user}, ${x}`).join('\n');
			this.bot1!.send(`|${outCode}`);
		}
	}

	#respondBR(msg: string) {
		const data = msg.split('|', 4);
		const room = data[0].slice(1, -1);
		const user = toID(data[2].slice(1));
		const fields = data[3].slice(1).split(' ');

		const out = this.runCommand(user, ...fields);
		if(!out) return;

		if(out.includes('\n')) this.bot1!.send(`${room}|!code ${out}`);
		else this.bot1!.send(`${room}|${out}`);
	}

	// Refer to default for expected fields
	runCommand(user: string, ...fields: string[]): string {
		switch(fields[0].toLowerCase()) {
			case 'in':
			case 'can': {
				if(this.queue.includes(user)) return 'You are already in the matchmaking queue.';
				if(this.queueBan.includes(user)) return 'You can not enter the matchmaking queue at the moment.'
				this.queue.push(user);
				return `You have entered the matchmaking queue. There are ${this.queue.length - 1} other players in queue.`;
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
				// if chal formats non-matching, reject and inform both
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
				if(!fields[2]) return 'Provide a format in your query.';
				if(!fields[2].endsWith('.txt')) fields[2] += '.txt';
				if(!(fields[2] in this.factorySets)) return 'Format not found. Check your syntax, it should be like ```2025/2025_04```';
				fields[1] = toID(fields[1]);
				if(!(fields[1] in this.factorySets[fields[2]])) return 'Species not found in format. Try including or excluding forme suffix.';
				const data = this.factorySets[fields[2]][fields[1]];
				let buf = `${fields[1]} weight ${data.weight}`;
				for(const x of data.sets as FactorySet[]) {
					const evs = Object.entries(x.evs).filter((y) => y[1] > 0).map((y) => `${y[1]} ${y[0]}`).join(' / ');
					const ivs = Object.entries(x.ivs).filter((y) => y[1] < 31).map((y) => `${y[1]} ${y[0]}`).join(' / ');
					buf += '\n\n';
					buf += `${x.weight}% @ ${x.item.join(' / ')}\n`;
					buf += `Ability: ${x.ability.join(' / ')}\n`;
					if(evs) buf += `EVs: ${evs}\n`;
					buf += `${x.nature.join(' / ')} Nature\n`;
					if(ivs) buf += `IVs: ${ivs}\n`;
					for(const y of x.moves) {
						buf += `- ${y.join(' / ')}\n`;
					}
					buf = buf.slice(0, -1);
				}
				return buf;
			}
			case 'formats': {
				return Object.keys(this.factorySets).map((x) => x.endsWith('.txt') ? x.slice(0, -4) : x).join(', ');
			}
			case 'hotpatch': {
				if(!this.sudoers.includes(user)) return 'Not allowed.';
				this.loadConfig();
				return 'Done!';
			}
			default: return '35 Factory Commands (prefix ; in battle rooms):\n\n' +
			'in: Enter the matchmaking queue. Alias: can\n\n' +
			'out: Exit the matchmaking queue. Alias: leave, exit\n\n' +
			'chal user format?: Challenge user to format (user must challenge back to accept) (user is not notified). Alias: challenge\n\n' +
			'unchal: Withdraw your active challenge. Alias: unchallenge\n\n' +
			'bf species format: Query sets in format. Alias: set, sets\n\n' +
			'formats: Get the list of rollable formats.';
		}
	}

	readonly #BATTLE_1: PredicateVar = (val) => (msg) => {
		const data = msg.split('|', 4);
		if(data[1] !== 'queryresponse' || data[2] !== 'userdetails') return null;
		const details = JSON.parse(data[3]);
		if(details.userid !== val) return null;
		return !!details.rooms;
	}

	readonly #BATTLE_2: PredicateVar = (val) => (msg) => {
		const data = msg.split('|', 5);
		return data[1] === 'pm' &&
		data[2]?.slice(1) === this.bot1!.username &&
		data[3]?.slice(1) === this.bot2!.username &&
		data[4]?.startsWith(`/challenge ${val}`) ||
		null;
	}

	readonly #BATTLE_3: Predicate = (msg) => {
		const data = msg.split('\n', 3).map((x) => x.split('|', 3));
		return data[0][0].startsWith('>battle-gen9nationaldex35pokes-') &&
		data[1]?.[1] === 'init' &&
		data[1]?.[2] === 'battle' &&
		data[2]?.[1] === 'title' &&
		data[2]?.[2] === `${this.bot1!.username} vs. ${this.bot2!.username}` ||
		null;
	}

	readonly #BATTLE_4: PredicateVar = (val) => (msg) => {
		const data = msg.split('\n').map((x) => x.split('|', 2));
		return data[0][0].slice(1) === val &&
		// @ts-expect-error Please shut up
		['win', 'tie'].includes(data.pop()?.[1]) ||
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
		const data = msg.split('|', 5);
		return data[0] === '' &&
		data[1] === 'pm' &&
		// The sender must be anyone except our bots; the recipient must be our main bot.
		![this.bot1!.username, this.bot2!.username].includes(data[2]?.slice(1)) &&
		data[3]?.slice(1) === this.bot1!.username &&
		// Ignore '/challenge' and other commands.
		data[4]?.[0] !== '/' ||
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
