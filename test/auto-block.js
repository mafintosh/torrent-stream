var test = require('tap').test
var torrents = require('../')
var fs = require('fs-extra')
var path = require('path')
var bufferAlloc = require('buffer-alloc')

var torrent = fs.readFileSync(path.join(__dirname, 'data', 'test.torrent'))
var tmpPath = path.join(__dirname, '..', 'torrents', 'test')
fs.removeSync(tmpPath)
fs.copySync(path.join(__dirname, 'data'), tmpPath)

var fixture = torrents(torrent, {
  dht: false,
  tracker: false,
  path: tmpPath
})

fixture.listen(10000)

test('fixture can verify the torrent', function (t) {
  t.plan(2)
  fixture.on('ready', function () {
    t.ok(true, 'seed should be ready')
    t.deepEqual(fixture.bitfield.buffer.toString('hex'), 'c0', 'should verify all the pieces')
  })
})

test('peer should be blocked on bad piece', function (t) {
  t.plan(4)

  fixture.store.put(0, bufferAlloc(1 << 15), function () {
    t.ok(true, 'bad piece should be written')

    var engine = torrents(torrent, {
      dht: false,
      tracker: false,
      tmp: tmpPath
    })

    engine.on('blocking', function (addr) {
      t.equal(addr, '127.0.0.1:10000')
      engine.destroy(t.ok.bind(t, true, 'peer should be destroyed'))
    })

    engine.connect('127.0.0.1:10000')

    engine.swarm.once('wire', function () {
      fixture.swarm.wires[0].unchoke()
    })

    engine.on('ready', function () {
      t.ok(true, 'peer should be ready')
      engine.files[0].select()
    })
  })
})

test('cleanup', function (t) {
  t.plan(1)
  fixture.destroy(t.ok.bind(t, true, 'seed should be destroyed'))
})
