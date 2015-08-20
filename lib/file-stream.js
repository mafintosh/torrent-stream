var stream = require('stream')
var util = require('util')

var FileStream = function (engine, file, opts) {
  if (!(this instanceof FileStream)) return new FileStream(engine, file, opts)
  stream.Readable.call(this)

  if (!opts) opts = {}
  if (!opts.start) opts.start = 0
  if (!opts.end && typeof opts.end !== 'number') opts.end = file.length - 1

  var offset = opts.start + file.offset
  var pieceLength = engine.torrent.pieceLength

  this.length = opts.end - opts.start + 1
  this.startPiece = (offset / pieceLength) | 0
  this.endPiece = ((opts.end + file.offset) / pieceLength) | 0
  this._destroyed = false
  this._engine = engine
  this._piece = this.startPiece
  this._missing = this.length
  this._reading = false
  this._notifying = false
  this._critical = Math.min(1024 * 1024 / pieceLength, 2) | 0
  this._offset = offset - this.startPiece * pieceLength
}

util.inherits(FileStream, stream.Readable)

FileStream.prototype._read = function () {
  if (this._reading) return
  this._reading = true
  this.notify()
}

FileStream.prototype.notify = function () {
  if (!this._reading || !this._missing) return
  if (!this._engine.bitfield.get(this._piece)) return this._engine.critical(this._piece, this._critical)

  var self = this

  if (this._notifying) return
  this._notifying = true
  this._engine.store.get(this._piece++, function (err, buffer) {
    self._notifying = false

    if (self._destroyed || !self._reading) return

    if (err) return self.destroy(err)

    if (self._offset) {
      buffer = buffer.slice(self._offset)
      self._offset = 0
    }

    if (self._missing < buffer.length) buffer = buffer.slice(0, self._missing)

    self._missing -= buffer.length

    if (!self._missing) {
      self.push(buffer)
      self.push(null)
      return
    }

    self._reading = false
    self.push(buffer)
  })
}

FileStream.prototype.destroy = function () {
  if (this._destroyed) return
  this._destroyed = true
  this.emit('close')
}

module.exports = FileStream
