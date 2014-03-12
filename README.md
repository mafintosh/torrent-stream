# peerflix-engine

The streaming torrent engine that [peerflix](https://github.com/mafintosh/peerflix) (will) use

	npm install peerflix-engine

## Disclamer

This module is under heavy development. Here be dragons

## How can I help?

1. Open issues on things that are broken
2. Fix open issues by sending PRs
3. Add documentation

## Usage

peerflix-engine is a node module that allows you to access files inside a torrent as node streams.

``` js
var peerflixEngine = require('peerflix-engine');
var fs = require('fs');

var engine = peerflixEngine(fs.readFileSync('my-test-file.torrent'));

engine.files.forEach(function(file) {
	console.log('filename:', file.name);
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
If you want to fetch a file anyway use the `file.select` and `file.deselect` method.

When you start peerflix-engine it will connect to the torrent dht
and fetch pieces according to the streams you create.

## Full API

#### `engine = peerflixEngine(opts)`

Create a new engine instance. Options can contain the following

``` js
{
	size: 100,           // Max amount of peers to be connected to.
	path: '/tmp/my-file' // Where to save the buffer data.
}
```

#### `engine.verify(cb)`

Verify the currently saved data before starting the swarm.
You should call this as the first method if you want to persist data.

#### `engine.files[...]`

An array of all files in the torrent. See the file section for more info on what methods the file has

#### `engine.destroy(cb)`

Destroy the engine (including the saved data) completely. The callback is optional

#### `engine.listen([port], cb)`

Listen for incoming peers on the specified port. Port defaults to `6881`

#### `engine.swarm`

The attached [peer-wire-swarm](https:/github.com/mafintosh/peer-wire-swarm) instance

#### `file = engine.files[...]`

A file in the torrent. They contains the following data

``` js
{
	name: 'my-filename.txt',
	path: 'my-folder/my-filename.txt',
	length: 424242
}
```

#### `file.select()`

Selects the file to be downloaded, but at a lower priority than streams.
Useful if you know you need the file at a later stage.

#### `file.deselect()`

Deselects the file which means it won't be downloaded unless someone creates a stream to it

#### `stream = file.createReadStream(opts)`

Create a readable stream to the file. Pieces needed by the stream will be prioritized highly.
Options can contain the following

``` js
{
	start: startByte,
	end: endByte
}
```

Both `start` and `end` are inclusive

## License

MIT