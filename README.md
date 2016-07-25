# torrent-stream

[![Travis Build branch](https://img.shields.io/travis/mafintosh/torrent-stream/master.svg)](https://travis-ci.org/mafintosh/torrent-stream)
[![Dependency Status](https://david-dm.org/mafintosh/torrent-stream.svg)](https://david-dm.org/mafintosh/torrent-stream) [![devDependency Status](https://david-dm.org/mafintosh/torrent-stream/dev-status.svg)](https://david-dm.org/mafintosh/torrent-stream#info=devDependencies)

The streaming torrent engine that [peerflix](https://github.com/mafintosh/peerflix) uses

	npm install torrent-stream

## How can I help?

1. Open issues on things that are broken
2. Fix open issues by sending PRs
3. Add documentation

## Usage

torrent-stream is a node module that allows you to access files inside a torrent as node streams.

``` js
var torrentStream = require('torrent-stream');

var engine = torrentStream('magnet:my-magnet-link');

engine.on('ready', function() {
	engine.files.forEach(function(file) {
		console.log('filename:', file.name);
		var stream = file.createReadStream();
		// stream is readable stream to containing the file content
	});
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
If you want to fetch a file without creating a stream you should use the `file.select` and `file.deselect` methods.

When you start torrent-stream it will connect to the torrent dht
and fetch pieces according to the streams you create.

## Full API

#### `engine = torrentStream(magnet_link_or_buffer, opts)`

Create a new engine instance. Options can contain the following

``` js
{
	connections: 100,     // Max amount of peers to be connected to.
	uploads: 10,          // Number of upload slots.
	tmp: '/tmp',          // Root folder for the files storage.
	                      // Defaults to '/tmp' or temp folder specific to your OS.
	                      // Each torrent will be placed into a separate folder under /tmp/torrent-stream/{infoHash}
	path: '/tmp/my-file', // Where to save the files. Overrides `tmp`.
	verify: true,         // Verify previously stored data before starting
	                      // Defaults to true
	dht: true,            // Whether or not to use DHT to initialize the swarm.
	                      // Defaults to true
	tracker: true,        // Whether or not to use trackers from torrent file or magnet link
	                      // Defaults to true
	trackers: [
	    'udp://tracker.openbittorrent.com:80',
	    'udp://tracker.ccc.de:80'
	],
	                      // Allows to declare additional custom trackers to use
	                      // Defaults to empty
	storage: myStorage()  // Use a custom storage backend rather than the default disk-backed one
}
```

#### `engine.on('ready', fn)`

Emitted when the engine is ready to be used.
The files array will be empty until this event is emitted

#### `engine.on('download', [piece-index])`

Emitted everytime a piece has been downloaded and verified.

#### `engine.on('upload', [piece-index, offset, length])`

Emitted everytime a piece is uploaded.

#### `engine.on('torrent', fn)`

Emitted when the metadata has been fetched.

#### `engine.on('idle', fn)`

Emitted when all selected files have been completely downloaded.

#### `engine.files[...]`

An array of all files in the torrent. See the file section for more info on what methods the file has

#### `engine.destroy(cb)`

Destroy the engine. Destroys all connections to peers

#### `engine.connect('127.0.0.0:6881')`

Connect to a peer manually

#### `engine.disconnect('127.0.0.1:6881')`

Disconnect from a peer manually

#### `engine.block('127.0.0.1:6881')`

Disconnect from a peer and add it to the blocklist, preventing any other connection to it

#### `engine.remove([keep-pieces], cb)`

Completely remove all saved data for this torrent.
Optionally, only remove cache and temporary data but keep downloaded pieces

#### `engine.listen([port], cb)`

Listen for incoming peers on the specified port. Port defaults to `6881`

#### `engine.swarm`

The attached [peer-wire-swarm](https://github.com/mafintosh/peer-wire-swarm) instance

#### `engine.swarm.downloaded`

Shows the total bytes downloaded. With this you can know how much you downloaded and how many bytes you still have to download to reach the end of the file. 

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
