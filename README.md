# peerflix-engine

The streaming torrent engine that [peerflix](https://github.com/mafintosh/peerflix) (will) use

	npm install peerflix-engine

## Disclamer

This module is under heavy development. Here be dragons

## Usage

peerflix-engine is a node module that allows you to access files inside a torrent as node streams.

``` js
var pe = require('peerflix-engine');
var fs = require('fs');

var engine = pe(fs.readFileSync('my-test-file.torrent'));

engine.files.forEach(function(file) {
	console.log('filename: '+file.name);
	var stream = file.createReadStream();
	// stream is readable stream to containing the file content
});
```

You can pass `start` and `end` options to stream to slice the file

``` js
// get a stream containing bytes 10-100 inclusive.
var stream = file.createReadStream({
	start: 10,
	end: 100
});
```

Per default no files are downloaded unless you create a stream to them.
If you want to fetch a file anyway use the `file.select` and `file.deselect` method

``` js
file.select(); // file will be downloaded at a lower prio than any existing streams
```

When you start peerflix-engine it will connect to the torrent dht
and fetch pieces according to the streams you create.

## How can I help?

1. Open issues on things that are broken
3. Fix open issues by sending PRs
2. Help making the documentation better

## License

MIT