
// entry point

// manip showdown dist files here

// expose interfaces here based on config.features

// expose tools to refresh seamlessly (git pull, build, etc)

// node build decl

/*
silences unnecessary errors
.catch((err) => {
	// Likely error in code
	if(typeof err !== 'string') throw err;
	// No need to announce
	if(Object.values(RejectReason).includes(err as RejectReason)) throw 0;
	// Handle expected error
})
*/
