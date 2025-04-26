# 35Pokes Pokemon Showdown Bot

Showdown bots for the 35 Pokes community.

PSBot.ts is a single barebones `WebSocket` client. It comes with the functionality to send and receive messages, connect, login and disconnect on the main server, and optionally display colorful logs. Users are provided with 2 methods to implement further functionality:

`PSBot.onMessage` can be assigned a function which will be passed every incoming message after internal processing. Useful for responding to irregular events like player queries.

`PSBot.await` can be called with a predicate and a timeout to expect and act upon a certain message within the timeout. This will always be called before the former method. Useful for message exchanges.

Internally, the bot uses the builtin `WebSocket` class and a homebrew message listener queue which, unlike the builtin event listener, is not limited to 1 listener per function and so does not have to rely on `AbortSignal`s, making the bot simple to debug.
