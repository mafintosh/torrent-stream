var rangeParser = require('range-parser');
var http = require('http');
var pump = require('pump');
var fs = require('fs');
var pe = require('./index');

var client = pe(fs.readFileSync('./torrents/star-wreck.torrent'), {
	path: '/tmp/peerflix'
});

client.on('verify', function(index) {
	console.log('verified', index);
});

client.on('upload', function(index) {
	console.log('uploaded', index);
});

client.on('download', function(index) {
	console.log('downloaded', index);
});

client.once('wire', function() {
	console.log('starting download');
});

client.verify(function() {
	var file = client.files[1];
	var server = http.createServer();

	var onjson = function(response) {
		response.end(JSON.stringify({
			selection: client.selection,
			wires: client.wires.map(function(wire) {
				return {
					peerAddress: wire.peerAddress,
					downloaded: wire.downloaded,
					downloadSpeed: wire.downloadSpeed()
				};
			}).sort(function(a, b) {
				return b.downloadSpeed - a.downloadSpeed || a.peerAddress.localeCompare(b.peerAddress);
			})
		}));
	};

	server.on('request', function(request, response) {
		if (request.url === '/.json') return onjson(response);
		if (request.url === '/favicon.ico') return response.end();

		var range = request.headers.range;
		range = range && rangeParser(file.length, range)[0];
		response.setHeader('Accept-Ranges', 'bytes');

		if (!range) {
			response.setHeader('Content-Length', file.length);
			if (request.method === 'HEAD') return response.end();
			pump(file.createReadStream(), response);
			return;
		}

		response.statusCode = 206;
		response.setHeader('Content-Length', range.end - range.start + 1);
		response.setHeader('Content-Range', 'bytes '+range.start+'-'+range.end+'/'+file.length);

		if (request.method === 'HEAD') return response.end();
		pump(file.createReadStream(range), response);
	});

	file.select();

	server.listen(10003);
	console.log('ready!');
});