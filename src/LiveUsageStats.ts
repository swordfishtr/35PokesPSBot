/**
 * Live Usage Stats service
 * 
 * Configuration details:
 * enable - whether Controller should run this service.
 * debug - whether to display informational logs.
 * interval - in seconds, how often to check public battles.
 * serveData - expose API that responds with usage stats (requires express).
 * port - if serveData = true, system port to listen on.
 * portEnv - if serveData = true and port = 0, environment variable for the port.
 * password - if not empty, only serve those who provide password.
 */

import PSBot from './PSBot.js';

//import express from 'express';

export default class LiveUsageStats {

	#init: boolean = false;
	debug: boolean = false;
	interval: number = 60;
	serve: boolean = false;
	bot?: PSBot;

	constructor() {}
	
	async init() {
		if(this.#init) return;
		this.#init = true;

		const { debug, interval, serveData } = (await import('../config.json', { with: { type: "json" } })).default.liveUsageStats;
		this.debug = !!debug;
		if(interval) this.interval = Number(interval);
		this.serve = !!serveData;
	}

	async connect() {
		if(!this.#init) return;
		this.bot = new PSBot('Live Battle Observer Bot', this.debug);
		await this.bot.connect();
		this.bot.onDisconnect = () => {};
	}

}

const app = (await import('express')).default();

const configPort = 0;
const configPortEnv = '';
const port = configPort || configPortEnv ? process.env[configPortEnv] : 0 || 3000;

app.get('/', (req, res) => {
	res.send('Ayo');
});

app.listen(port, () => {
	console.log(`Started on ${port}`);
});

/*

>> |/cmd roomlist gen9nationaldex35pokes,none,
<< |queryresponse|roomlist|{"rooms":{}}

<< |queryresponse|roomlist|{"rooms":{"battle-gen9nationaldexuu-2349962948":{"p1":"AshPlaysMonss","p2":"2dasdsd","minElo":1000},"battle-gen9nationaldexuu-2349962535":{"p1":"Fowa2003","p2":"Kairak","minElo":1212},"battle-gen9nationaldexuu-2349962066":{"p1":"Kairak","p2":"Knurzerr","minElo":1277},"battle-gen9nationaldexuu-2349961197":{"p1":"sbwavez","p2":"Skalz15","minElo":1057},"battle-gen9nationaldexuu-2349956651":{"p1":"rmxq_bxllz","p2":"Override 12345"}}}

*/
