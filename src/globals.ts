export interface Auth {
	name: string,
	pass: string
}

/**
 * Resolved with the matching message.
 * Rejected with the matching message or RejectReason.
 * 
 * true:resolve, null:ignore, false:reject
 */
export type Predicate = (msg: string) => boolean | null;

/** Curried Predicate */
export type PredicateVar = (val: string) => Predicate;

export type Problems = string[];

export enum LogSign {
	IN = '<<',
	OUT = '>>',
	INFO = '::',
	WARN = '!!',
	ERR = 'XX'
}

export enum RejectReason {
	TIMEOUT = 'Timed out.',
	DISCONNECT = 'Disconnected.'
}
