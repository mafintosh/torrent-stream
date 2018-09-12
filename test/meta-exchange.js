var test = require('tap').test
var torrents = require('../')
var fs = require('fs')
var path = require('path')

var fixture = torrents(fs.readFileSync(path.join(__dirname, 'data', 'star.torrent')), {
  dht: false,
  tracker: false
})
fixture.listen(10000)

var engine = function () {
  var e = torrents('magnet:?xt=urn:btih:ef330b39f4801d25b4245212e75a38634bfc856e', {
    dht: false,
    tracker: false
  })

  e.connect('127.0.0.1:10000')
  return e
}

test('fixture should be ready', function (t) {
  t.plan(1)
  fixture.on('ready', t.ok.bind(t, true, 'should be ready'))
})

test('torrent should be emitted', function (t) {
  t.plan(1)
  var e = engine()
  e.on('torrent', function (torrent) {
    t.equal(torrent.infoHash, 'ef330b39f4801d25b4245212e75a38634bfc856e')
    e.destroy(t.ok.bind(t, true, 'should be destroyed'))
  })
})

test('remove fixture and all content', function (t) {
  t.plan(1)
  fixture.destroy(function () {
    fixture.remove(function () {
      t.ok(!fs.existsSync(fixture.path))
    })
  })
})
