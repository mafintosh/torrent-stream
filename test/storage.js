var test = require('tap').test
var torrents = require('../')
var fs = require('fs')
var path = require('path')

var torrent = fs.readFileSync(path.join(__dirname, 'data', 'test.torrent'))

var fixture = torrents(torrent, {
  dht: false,
  tracker: false,
  path: path.join(__dirname, 'data')
})

test('fixture can verify the torrent', function (t) {
  t.plan(2)
  fixture.once('ready', function () {
    t.ok(true, 'should be ready')
    t.deepEqual(fixture.bitfield.buffer.toString('hex'), 'c0', 'should verify all the pieces')
  })
})

test('fixture can read the file contents', function (t) {
  t.equal(fixture.files.length, 1, 'should have one file')
  var file = fixture.files[0]
  t.test('can read from stream', function (t) {
    var stream = file.createReadStream()
    stream.setEncoding('ascii')
    t.plan(1)
    stream.once('readable', function () {
      t.equal(stream.read(11), 'Lorem ipsum')
    })
  })
  t.test('can read from stream with offset', function (t) {
    var stream = file.createReadStream({start: 36109})
    stream.setEncoding('ascii')
    t.plan(1)
    stream.once('readable', function () {
      t.equal(stream.read(6), 'amet. ')
    })
  })
  t.test('can read from storage', function (t) {
    t.plan(6)
    fixture.store.get(0, function (_, buffer) {
      t.equal(buffer.length, 32768)
      t.equal(buffer.toString('ascii', 0, 11), 'Lorem ipsum')
    })
    fixture.store.get(0, function (_, buffer) {
      t.equal(buffer.length, 32768)
      t.equal(buffer.toString('ascii', 588, 598), 'Vestibulum')
    })
    fixture.store.get(1, function (_, buffer) {
      t.equal(buffer.length, 3347)
      t.equal(buffer.toString('ascii', 3341), 'amet. ')
    })
  })
  t.test('can read from storage with offset', function (t) {
    t.plan(6)
    fixture.store.get(0, {length: 11}, function (_, buffer) {
      t.equal(buffer.length, 11)
      t.equal(buffer.toString('ascii'), 'Lorem ipsum')
    })
    fixture.store.get(0, {offset: 588, length: 10}, function (_, buffer) {
      t.equal(buffer.length, 10)
      t.equal(buffer.toString('ascii'), 'Vestibulum')
    })
    fixture.store.get(1, {offset: 3341}, function (_, buffer) {
      t.equal(buffer.length, 6)
      t.equal(buffer.toString('ascii'), 'amet. ')
    })
  })
  t.end()
})

test('cleanup', function (t) {
  t.plan(1)
  fixture.destroy(t.ok.bind(t, true, 'should be destroyed'))
})
