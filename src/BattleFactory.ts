/**
 * Battle Factory service
 * 
 * Configuration details:
 * enable - whether Controller should run this service.
 * Make sure to provide the files manually. Required for systems with <1GB of memory.
 * maxRestartCount - max number of disconnections within maxRestartTimeframe.
 * If this is surpassed, the service won't restart automatically.
 * maxRestartTimeframe - Timeframe in minutes for maxRestartCount.
 * serve - whether to expose data via http server under /bf.
 * interval - in seconds, how often to attempt matchmaking.
 * sudoers - list of showdown usernames to allow admin actions.
 * banned - list of showdown usernames to not generate battles for.
 * botAuth1 - botAuth2 - showdown accounts for the service to operate.
 */

import fs from 'fs';
import { styleText } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import PSBot from './PSBot.js';
import {
	Auth, FactorySet, fsLog, importJSON, LogSign, PATH_35_FACTORYSETS, PATH_CONFIG, PATH_MISCLOG, PATH_PS_FACTORYSETS, PATH_PS_INDEX, Predicate,
	PredicateRejection, PredicateVar, Services, ServiceState,
} from './globals.js';

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

interface GeneratedTeams {
	format: string,
	isRandom: boolean,
	chalcode: string,
	teams: any[]
}

type Challenge = { target: string, format: string | null, timeoutid: NodeJS.Timeout };

type ChallengeTable = { [user: string]: Challenge };

// TODO: fill out empty errors.

export default class BattleFactory {

	static readonly dependencies: string[] = [PATH_35_FACTORYSETS, '../../pokemon-showdown'];

	#state = ServiceState.NEW;
	readonly sudoers: string[] = [];

	readonly queue: string[] = [];
	#queueInterval?: NodeJS.Timeout;

	readonly queueBan: string[] = [];
	readonly fullBan: string[] = [];

	readonly challenges: ChallengeTable = {};

	/** Whether the bots are able to challenge. */
	ready: boolean = true;

	bot1?: PSBot;
	bot2?: PSBot;

	// Showdown
	Dex?: typeof import('../../pokemon-showdown/dist/sim/index.js').Dex;
	Teams?: typeof import('../../pokemon-showdown/dist/sim/index.js').Teams;
	TeamValidator?: typeof import('../../pokemon-showdown/dist/sim/index.js').TeamValidator;
	toID?: typeof import('../../pokemon-showdown/dist/sim/index.js').toID;

	// factory-sets.json
	factorySets: any;

	factoryGenerator: any;

	factoryValidator: any;
	factoryValidatorUbers: any;

	readonly teamErrors: string[] = [];

	readonly chalcode = 'gen9nationaldex35pokes@@@+allpokemon,+unobtainable,+past,+shedtail,+tangledfeet';
	readonly chalcodeUbers = 'gen9nationaldex35pokes@@@!obtainableformes,!evasionabilitiesclause,!drypassclause,batonpassclause,-allpokemon,+unobtainable,+past,-nduber,-ndag,-ndou,-nduubl,-nduu,-ndrubl,-ndru,-ndnfe,-ndlc,+forretress,+samurott-hisui,+kyurem-white,+glalie-base,+cresselia,+thundurus-base,+regidrago,+banette-mega,+banettite,+dialga-origin,+giratina-origin,+palkia-base,+arceus-rock,+lunala,+machamp,+manectric-mega,+manectite,+naganadel,+pincurchin,+meloetta-pirouette,+blissey,+alakazam-mega,+alakazite,+aggron-mega,+aggronite,+ogerpon-hearthflame-tera,+hoopa-unbound,+dragapult,+camerupt-mega,+cameruptite,+tyranitar-mega,+tyranitarite,+gothitelle,+skarmory,+deoxys-speed,+floette-eternal,+gastrodon,+dhelmise,+sceptile-mega,+sceptilite,+irontreads,+victini,-darkvoid,-grasswhistle,-hypnosis,-lovelykiss,-sing,-sleeppowder,+lastrespects,+moody,+shadowtag,+battlebond,+powerconstruct,+acupressure,+batonpass+contrary,+batonpass+rapidspin,+shedtail,+tangledfeet';

	readonly dqTimer = 5 * 60;
	readonly maxBattleDuration = 6 * 60 * 60;
	readonly lagGracePeriod = 30;

	onShutdown?: () => void;

	readonly init = async () => {
		if(this.#state !== ServiceState.NEW) throw new Error();
		await this.loadConfig();
		this.#state = ServiceState.INIT;
	};

	readonly loadConfig = async () => {
		this.factorySets = importJSON(PATH_PS_FACTORYSETS);

		const PS = (await import(PATH_PS_INDEX)).default;
		this.Dex = PS.Dex;
		this.Teams = PS.Teams;
		this.TeamValidator = PS.TeamValidator;
		this.toID = PS.toID;

		const formatBattleFactory = this.Dex!.formats.get('gen9battlefactory');
		this.factoryGenerator = this.Teams!.getGenerator(formatBattleFactory);

		const format35Pokes = this.Dex!.formats.get(this.chalcode);
		const format35PokesUbers = this.Dex!.formats.get(this.chalcodeUbers);
		this.factoryValidator = new this.TeamValidator!(format35Pokes);
		this.factoryValidatorUbers = new this.TeamValidator!(format35PokesUbers);

		const { banned, sudoers } = importJSON(PATH_CONFIG).battleFactory;
		this.fullBan.length = 0;
		this.fullBan.push(...banned);
		this.sudoers.length = 0;
		this.sudoers.push(...sudoers);
	};

	readonly connect = async () => {
		if(this.#state !== ServiceState.INIT) throw new Error();

		this.bot1 = new PSBot('35 Factory Primary Bot', this);
		this.bot2 = new PSBot('35 Factory Secondary Bot', this);

		this.bot1.onDisconnect = this.shutdown;
		this.bot2.onDisconnect = this.shutdown;

		const { botAuth1, botAuth2, interval } = importJSON(PATH_CONFIG).battleFactory;

		try {
			await this.bot1.connect();
			await this.bot1.login(botAuth1 as Auth);
			await this.bot2.connect();
			await this.bot2.login(botAuth2 as Auth);
			this.#state = ServiceState.ON;
			this.#queueInterval = setInterval(this.tryMatchmaking, (interval || 5) * 1000);
			this.bot1.onMessage = this.receive;
			this.bot2.onMessage = this.rejectChallenges(this.bot2);
		}
		catch(e) {
			this.shutdown();
			throw e;
		}
	};

	readonly shutdown = () => {
		if(this.#state === ServiceState.OFF) return;
		if(![ServiceState.INIT, ServiceState.ON].includes(this.#state)) throw new Error();

		delete this.bot1?.onDisconnect;
		delete this.bot2?.onDisconnect;

		this.bot1?.disconnect();
		this.bot2?.disconnect();

		clearInterval(this.#queueInterval);
		if(this.onShutdown) this.onShutdown();

		this.#state = ServiceState.OFF;
	};

	readonly log = (msg: string, sign: Extract<LogSign, LogSign.ERR | LogSign.INFO | LogSign.WARN>) => {
		const time = Temporal.Now.zonedDateTimeISO().toLocaleString();
		let buf = `${time} :: BF :: ${msg}\n`;
		fsLog(PATH_MISCLOG, buf);
		if(sign === LogSign.INFO) buf = styleText(['green', 'bold'], buf);
		else if(sign === LogSign.WARN) buf = styleText(['yellow', 'bold'], buf);
		else buf = styleText(['red', 'bold'], buf);
		console.log(buf);
	};

	/** Dump debugging data. */
	readonly dump = () => {
		let buf = 'Battle Factory Dump\n';
		buf += `state: ${this.#state}\n`;
		buf += `sudoers: ${this.sudoers.join(', ')}\n`
		buf += `queue: ${this.queue.join(', ')}\n`;
		buf += `queueBan: ${this.queueBan.join(', ')}\n`;
		buf += `fullBan: ${this.fullBan.join(', ')}\n`;
		buf += `challenges: ${Object.entries(this.challenges).map((x) => `${x[0]} for ${x[1].target} to ${x[1].format ?? 'random'}`).join(', ')}\n`;
		buf += `factorySets: ${this.factorySets ? 'loaded' : 'missing'}\n`;
		buf += `factoryGenerator: ${this.factoryGenerator ? 'loaded' : 'missing'}\n`;
		buf += `factoryValidator: ${this.factoryValidator ? 'loaded' : 'missing'}\n`;
		buf += `bot1 listeners:\n${this.bot1?.ls.map((x) => x.description).join(',\n')};\n`;
		buf += `bot2 listeners:\n${this.bot2?.ls.map((x) => x.description).join(',\n')};\n`;
		buf += `teamErrors:\n${this.teamErrors.join(',\n')};\n`;
		return buf;
	};

	/** Try to generate a random format battle for users in queue. */
	readonly tryMatchmaking = async () => {
		if(this.#state !== ServiceState.ON) throw new Error();
		if(!this.ready || this.queue.length < 2) return;

		const [user1, user2] = this.queue.slice(0, 2);

		// If either is offline, remove from queue and retry.
		const offline = await this.ensurePlayersOnline(user1, user2);
		if(offline.length) {
			for(const x of offline) {
				const i = this.queue.indexOf(x);
				this.queue.splice(i, 1);
			}
			return;
		}

		// To prevent matchmaking spam, players are only allowed to be in 1 game at a time.
		this.queueBan.push(user1, user2);
		for(const x of [user1, user2]) {
			const i = this.queue.indexOf(x);
			if(i !== -1) this.queue.splice(i, 1);
		}

		const genTeams = this.genTeams(2);
		const battle = this.prepBattle(user1, user2, genTeams);
		await this.startBattle(battle);

		for(const x of [user1, user2]) {
			const i = this.queueBan.indexOf(x);
			if(i !== -1) this.queueBan.splice(i, 1);
		}
	};

	/** Returns offline usernames. */
	readonly ensurePlayersOnline = async (...usernames: string[]): Promise<string[]> => {
		if(this.#state !== ServiceState.ON) throw new Error();

		const userids = usernames.map(this.toID!);
		for(const x of userids) { this.bot1!.send(`|/cmd userdetails ${x}`); }
		const queries = userids.map((x) => this.bot1!.await(`userdetails ${x}`, this.lagGracePeriod, this.#BATTLE_1(x)));
		const responses = await Promise.allSettled(queries);
		return usernames.filter((x, i) => responses[i].status === 'rejected');
	};

	/** Returns all the necessary random elements for prepBattle. */
	readonly genTeams = (amount: number, format?: string | null): GeneratedTeams => {
		if(![ServiceState.INIT, ServiceState.ON].includes(this.#state)) throw new Error();
		if(amount < 1 || amount > 10 * 1000) throw new RangeError();

		let isRandom = false;

		if(!format) {
			const formats = Object.keys(this.factorySets);
			format = formats[Math.floor(Math.random() * formats.length)];
			isRandom = true;
		}

		this.factoryGenerator.factoryTier = format;

		let validator: any;
		let chalcode: string;

		if(format === 'Uber' || format.startsWith('Seniors/')) {
			chalcode = this.chalcodeUbers;
			validator = this.factoryValidatorUbers;
		}
		//else if(battle.format.startsWith('Perfect/')) { if not A1 or A2 }
		else {
			chalcode = this.chalcode;
			validator = this.factoryValidator;
		}

		const teams: any[] = [];
		while(teams.length < amount) {
			const team = this.factoryGenerator.getTeam();
			// The generator reverts battle-only forms to base; we'll undo it manually.
			if(validator === this.factoryValidatorUbers) {
				for(const mon of team) {
					// This will fail in case of >1 forms of a species in factory sets.
					if(!(this.toID!(mon.species) in this.factorySets[format])) {
						const proper = Object.keys(this.factorySets[format]).find((x) => this.Dex!.species.get(x).battleOnly === mon.species)!;
						mon.species = proper;
					}
				}
			}
			const problems: string[] | null = validator.baseValidateTeam(team);
			if(problems?.length) {
				this.teamErrors.push(problems.join(', '));
				// hardcode max 20 errors
				if(this.teamErrors.length >= 20) throw new Error(`Too many validator errors:\n${this.teamErrors.join(';\n')}`);
				continue;
			}
			teams.push(team);
		}

		return { format, isRandom, chalcode, teams };
	};

	/** Returns organized output from genTeams for genBattle. */
	readonly prepBattle = (user1: string, user2: string, genTeams: GeneratedTeams): Battle => {
		if(this.#state < ServiceState.INIT) throw new Error();
		const { teams: [team1, team2], ...misc } = genTeams;
		return {
			side1: { username: user1, team: this.Teams!.pack(team1) },
			side2: { username: user2, team: this.Teams!.pack(team2) },
			...misc
		};
	};

	/** Creates a battle and hands out invites. Returns winner or null if tie. */
	readonly startBattle = async (battle: Battle): Promise<string | null> => {
		if(this.#state !== ServiceState.ON) throw new Error();

		if(!this.ready) throw new Error('NOT READY!!!');
		this.ready = false;

		// No response for these.
		this.bot1!.send(`|/utm ${battle.side1.team}`);
		this.bot2!.send(`|/utm ${battle.side2.team}`);

		this.bot1!.send(`|/challenge ${this.bot2!.username}, ${battle.chalcode}`);
		await this.bot2!.await('challenge', this.lagGracePeriod, this.#BATTLE_2(battle.chalcode));

		this.bot2!.send(`|/accept ${this.bot1!.username}`);
		const msg_room = await this.bot1!.await('battle room', this.lagGracePeriod, this.#BATTLE_3);
		const room = msg_room.slice(1, msg_room.indexOf('\n'));

		this.log(`Started a ${battle.format} battle for ${battle.side1.username} and ${battle.side2.username} at ${room}`, LogSign.INFO);

		let intro = battle.format;
		if(intro.endsWith('.txt')) intro = intro.slice(0, -4);
		if(!battle.isRandom) intro += ' (user-selected)';

		this.bot1!.send(`${room}|35 Factory Format: ${intro}`);
		this.bot1!.send(`${room}|/timer on`);
		this.bot2!.send(`${room}|/timer on`);
		this.bot1!.send(`${room}|/leavebattle`);
		this.bot2!.send(`${room}|/leavebattle`);

		// Showdown's battle invite functionality is janky, so we have to go out of our way to determine when
		// a battle starts and ends and when another can be started; otherwise, we would risk undefined
		// behavior and crashes. Here are our intentions currently:
		//
		// - If both sides accept:
		// -- Ready for another battle immediately.
		// -- Await battle end for result.
		// - If either side is unresponsive until battle end:
		// -- Send cancelchal for all unresponsive sides.
		// -- Ready for another battle.
		// -- Await battle end for result (possibly a tie).
		// - If one side rejects invite:
		// -- If the other side hasn't accepted invite, send cancelchal.
		// -- Ready for another battle.
		// -- The result is the other side wins immediately.
		//
		// To passively indicate that everything is in order, bot2 should leave upon battle ready, and bot1
		// should stay until the battle result is determined.

		this.bot1!.send(`${room}|/addplayer ${battle.side1.username}, p1`);
		this.bot2!.send(`${room}|/addplayer ${battle.side2.username}, p2`);

		const promise_battleend = this.bot1!.await(`${room} end`, this.maxBattleDuration, this.#BATTLE_4(room));

		// Accepted or rejected.
		let p1responded = false;
		let p2responded = false;

		let rejectionWin = '';

		await Promise.all([
			Promise.race([
				this.bot1!.await(`${room} invite p1`, this.dqTimer + this.lagGracePeriod, this.#BATTLE_6(battle.side1.username, this.bot1!.username!))
				.finally(() => {
					p1responded = true;
				}),
				promise_battleend
			])
			.then((x) => {
				if(x.startsWith('>') && !rejectionWin) {
					this.bot1!.send(`|/cancelchallenge ${battle.side1.username}`);
				}
			}),
			Promise.race([
				this.bot2!.await(`${room} invite p2`, this.dqTimer + this.lagGracePeriod, this.#BATTLE_6(battle.side2.username, this.bot2!.username!))
				.finally(() => {
					p2responded = true;
				}),
				promise_battleend
			])
			.then((x) => {
				if(x.startsWith('>') && !rejectionWin) {
					this.bot2!.send(`|/cancelchallenge ${battle.side2.username}`);
				}
			})
		])
		.catch((e) => {
			if(!(e instanceof PredicateRejection)) throw e;
			const forfeit = this.toID!(e.message.split('|').pop()!.slice(10, -24));
			if(forfeit === battle.side1.username) {
				rejectionWin = battle.side2.username;
				if(!p2responded) this.bot2!.send(`|/cancelchallenge ${battle.side2.username}`);
			}
			else if(forfeit === battle.side2.username) {
				rejectionWin = battle.side1.username;
				if(!p1responded) this.bot1!.send(`|/cancelchallenge ${battle.side1.username}`);
			}
			else throw new Error();
		});

		this.ready = true;
		this.bot2!.send(`|/noreply /leave ${room}`);

		if(rejectionWin) {
			this.bot1!.send(`${room}|Win given to ${rejectionWin} by their opponent. (if this was a ladder match, you are free to join the queue again)`);
			this.bot1!.send(`|/noreply /leave ${room}`);
			this.log(`Battle ended in forfeit win given to ${rejectionWin} at ${room}`, LogSign.INFO);
			return rejectionWin;
		}

		const msg_end = await promise_battleend;
		const [end, winner] = msg_end.split('|').slice(-2);

		this.bot1!.send(`|/noreply /leave ${room}`);

		this.log(`Battle ${end === 'win' ? `won by ${winner}` : 'ended in tie'} at ${room}`, LogSign.INFO);

		//await this.bot1!.await('battle exit', 30, this.#BATTLE_5(room));

		return end === 'win' ? winner : null;
	};

	readonly receive = (msg: string) => {
		if(this.#state !== ServiceState.ON) throw new Error();
		this.rejectChallenges(this.bot1!)(msg);
		if(this.#BOTCMD_1(msg)) return this.respondPM(msg);
		if(this.#BOTCMD_2(msg)) return this.respondBR(msg);
	};

	// Getting too fancy here ...
	readonly rejectChallenges = (bot: PSBot) => (msg: string) => {
		if(this.#state !== ServiceState.ON) throw new Error();
		if(this.#BOTCMD_3(bot.username!)(msg)) {
			const data = msg.split('|', 5);
			const user = data[2].slice(1);
			bot.send(`|/reject ${user}`);
		}
	};

	readonly respondPM = async (msg: string) => {
		const data = msg.split('|', 5);
		const user = this.toID!(data[2].slice(1));
		const fields = data[4].split(' ');

		const out = await this.runCommand(user, ...fields);
		if(!out) return;

		const outLines = out.split('\n');
		if(outLines.length === 1) this.bot1!.send(`|/pm ${user}, ${out}`);

		else {
			outLines[0] = `!code ${outLines[0]}`;
			const outCode = outLines.map((x) => `/pm ${user}, ${x}`).join('\n');
			this.bot1!.send(`|${outCode}`);
		}
	};

	readonly respondBR = async (msg: string) => {
		const data = msg.split('|', 4);
		const room = data[0].slice(1, -1);
		const user = this.toID!(data[2].slice(1));
		const fields = data[3].slice(1).split(' ');

		const out = await this.runCommand(user, ...fields);
		if(!out) return;

		if(out.includes('\n')) this.bot1!.send(`${room}|!code ${out}`);
		else this.bot1!.send(`${room}|${out}`);
	};

	// Refer to default for expected fields
	readonly runCommand = async (user: string, ...fields: string[]): Promise<string> => {
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
				let buf = '';

				if(user in this.challenges) {
					buf += `Discarding your previous challenge for ${this.challenges[user].target} to ${this.challenges[user].format ?? 'a random format'}. ... `;
					clearTimeout(this.challenges[user].timeoutid);
					delete this.challenges[user];
				}

				if(!fields[1]) {
					buf += 'Provide a target username.';
					return buf;
				}

				const target = this.toID!(fields[1]);
				if(!target) {
					buf += `Target username ${fields[1]} is invalid.`;
					return buf;
				}

				const format = fields[2] ? ( fields[2].endsWith('.txt') || fields[2] === 'Uber' ) ? fields[2] : `${fields[2]}.txt` : null;
				if(format && !(format in this.factorySets)) {
					buf += `Format ${fields[2]} is not supported.`;
					return buf;
				}

				if(!this.ready) {
					buf += 'Can not start a battle right now, try again in a few minutes.';
					return buf;
				}

				if(target in this.challenges && this.challenges[target].target === user) {
					if(this.challenges[target].format === format) {
						clearTimeout(this.challenges[target].timeoutid);
						delete this.challenges[target];
						buf += `Accepted challenge from ${target}! ... `;
						const [offline] = await this.ensurePlayersOnline(target);
						if(offline) {
							buf += 'But they are offline.';
							return buf;
						}
						const genTeams = this.genTeams(2, format);
						const battle = this.prepBattle(target, user, genTeams);
						this.startBattle(battle);
						buf += 'Your battle is coming up.'
						return buf;
					}
					buf += `${target} is already challenging you to a different format (${this.challenges[target].format ?? 'random'}). ... `;
				}

				const chal: Challenge = { target, format, timeoutid: setTimeout(() => {
					if(this.challenges[user] === chal) delete this.challenges[user];
				}, 30 * 60 * 1000) };

				this.challenges[user] = chal;

				buf += `You have challenged ${target} to ${fields[2] ?? 'a random format'}. Ask your opponent to challenge back to accept. If left, this challenge will be discarded in 30 minutes.`;
				return buf;
			}
			case 'unchal':
			case 'unchallenge': {
				if(user in this.challenges) {
					let buf = `You withdraw your challenge to ${this.challenges[user].target} at ${this.challenges[user].format ?? 'random format'}.`;
					clearTimeout(this.challenges[user].timeoutid);
					delete this.challenges[user];
					return buf;
				}
				return 'You have no active challenge.';
			}
			case 'bf':
			case 'set':
			case 'sets': {
				if(!fields[2]) return 'Provide a format in your query.';
				if(!fields[2].endsWith('.txt')) fields[2] += '.txt';
				if(!(fields[2] in this.factorySets)) return 'Format not found. Check your syntax, it should be like ```2025/2025_04```';
				fields[1] = this.toID!(fields[1]);
				if(!(fields[1] in this.factorySets[fields[2]])) return 'Species not found in format. Try including or excluding forme suffix.';
				const data = this.factorySets[fields[2]];
				return BattleFactory.factoryToPaste(fields[1], data);
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
	};

	readonly #BATTLE_1: PredicateVar = (val) => (msg) => {
		const data = msg.split('|', 4);
		if(data[1] !== 'queryresponse' || data[2] !== 'userdetails') return null;
		const details = JSON.parse(data[3]);
		if(details.userid !== val) return null;
		return !!details.rooms && !!details.autoconfirmed;
	};

	readonly #BATTLE_2: PredicateVar = (val) => (msg) => {
		const data = msg.split('|', 5);
		return data[1] === 'pm' &&
		data[2]?.slice(1) === this.bot1!.username &&
		data[3]?.slice(1) === this.bot2!.username &&
		data[4]?.startsWith(`/challenge ${val}`) ||
		null;
	};

	readonly #BATTLE_3: Predicate = (msg) => {
		const data = msg.split('\n', 3).map((x) => x.split('|', 3));
		return data[0][0].startsWith('>battle-gen9nationaldex35pokes-') &&
		data[1]?.[1] === 'init' &&
		data[1]?.[2] === 'battle' &&
		data[2]?.[1] === 'title' &&
		data[2]?.[2] === `${this.bot1!.username} vs. ${this.bot2!.username}` ||
		null;
	};

	readonly #BATTLE_4: PredicateVar = (val) => (msg) => {
		const data = msg.split('\n').map((x) => x.split('|', 2));
		return data[0][0].slice(1) === val &&
		(['win', 'tie'] as any[]).includes(data.pop()?.[1]) ||
		null;
	};

	/* readonly #BATTLE_5: PredicateVar = (val) => (msg) => {
		const data = msg.split('\n', 2).map((x) => x.split('|', 2));
		return data[0][0].slice(1) === val &&
		data[1]?.[1] === 'deinit' ||
		null;
	} */

	readonly #BATTLE_6: PredicateVar = (user, bot) => (msg) => {
		const data = msg.split('|', 5);
		const prelim = data[0] === '' &&
		data[1] === 'pm' &&
		this.toID!(data[2]?.slice(1)) === user &&
		data[3]?.slice(1) === bot;
		if(!prelim) return null;
		if(data[4] === '/text You accepted the battle invite') return true;
		if(data[4] === `/nonotify ${user} rejected the challenge.`) return false;
		return null;
	};

	// pm
	readonly #BOTCMD_1: Predicate = (msg) => {
		const data = msg.split('|', 5);
		return data[0] === '' &&
		data[1] === 'pm' &&
		// The sender must be anyone except our bots; the recipient must be our main bot.
		![this.bot1?.username ?? null, this.bot2?.username ?? null].includes(data[2]?.slice(1)) &&
		data[3]?.slice(1) === this.bot1!.username &&
		// Ignore '/challenge' and other commands.
		data[4]?.[0] !== '/' ||
		null;
	};

	// battle room
	readonly #BOTCMD_2: Predicate = (msg) => {
		const data = msg.split('\n', 2).map((x) => x.split('|', 4));
		return data[1]?.[0] === '' &&
		data[1]?.[1] === 'c' &&
		// Bot command prefix in battle rooms
		data[1]?.[3]?.[0] === ';' ||
		null;
	};

	// challenges and invites
	readonly #BOTCMD_3: PredicateVar = (val) => (msg) => {
		const data = msg.split('|', 5);
		return data[0] === '' &&
		data[1] === 'pm' &&
		![this.bot1?.username ?? null, this.bot2?.username ?? null].includes(data[2]?.slice(1)) &&
		data[3]?.slice(1) === val &&
		// Note the trailing space - that implies a format follows, which means this was a voluntary action.
		// Ws clients receive '/challenge' whenever accepting or rejecting occurs; that is noise.
		data[4]?.startsWith('/challenge ') ||
		null;
	};

	static factoryToPaste(species: string, data: any): string {
		let buf = `${species} weight ${data[species].weight}`;
		for(const x of data[species].sets as FactorySet[]) {
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

	static async serve(services: Services): Promise<Express.Application> {
		const app = (await import('express')).default();
		app.get('/', (req, res) => {
			if(!services.BattleFactory) {
				res.status(503).json({ error: 'Battle Factory is disabled.' });
				return;
			}
			let buf = '';
			for(const meta in services.BattleFactory.factorySets) {
				buf += `<a href="/bf/${meta}">${meta}</a><br />`;
			}
			res.send(buf);
		});
		app.get('/:group/:meta', (req, res) => {
			// 401 if password wrong
			if(!services.BattleFactory) {
				res.status(503).json({ error: 'Battle Factory is disabled.' });
				return;
			}
			let meta = `${req.params.group}/${req.params.meta}`;
			if(!meta.endsWith('.txt')) meta += '.txt';
			if(!(meta in services.BattleFactory.factorySets)) {
				res.status(404).json({ error: 'Format not supported.' });
				return;
			}
			let buf = `<h1>${meta}</h1>`;
			for(const species in services.BattleFactory.factorySets[meta]) {
				buf += '===== ';
				buf += BattleFactory.factoryToPaste(species, services.BattleFactory.factorySets[meta]);
				buf += '\n\n';
			}
			buf = buf.replace(/\n/g, '<br />');
			res.send(buf);
		});
		return app;
	}

	static prelaunch() {
		console.log('Inserting custom factory-sets.json ...');
		fs.copyFileSync(PATH_35_FACTORYSETS, PATH_PS_FACTORYSETS);
	}

}
