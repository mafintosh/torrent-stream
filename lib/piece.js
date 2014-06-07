var BLOCK_SIZE = 1 << 14;

var PieceBuffer = function(length) {
	if (!(this instanceof PieceBuffer)) return new PieceBuffer(length);
	this.parts = Math.ceil(length / BLOCK_SIZE);
	this.remainder = (length % BLOCK_SIZE) || BLOCK_SIZE;
	this.length = length;
	this.missing = length;
	this.buffered = 0;
	this.buffer = null;
	this.cancellations = null;
	this.reservations = 0;
	this.sources = null;
	this.flushed = false;
};

PieceBuffer.BLOCK_SIZE = BLOCK_SIZE;

PieceBuffer.prototype.size = function(i) {
	return i === this.parts-1 ? this.remainder : BLOCK_SIZE;
};

PieceBuffer.prototype.offset = function(i) {
	return i * BLOCK_SIZE;
};

PieceBuffer.prototype.reserve = function() {
	if (!this.init()) return -1;
	if (this.cancellations.length) return this.cancellations.pop();
	if (this.reservations < this.parts) return this.reservations++;
	return -1;
};

PieceBuffer.prototype.cancel = function(i) {
	if (!this.init()) return;
	this.cancellations.push(i);
};

PieceBuffer.prototype.get = function(i) {
	if (!this.init()) return null;
	return this.buffer[i];
};

PieceBuffer.prototype.set = function(i, data, source) {
	if (!this.init()) return false;
	if (!this.buffer[i]) {
		this.buffered++;
		this.buffer[i] = data;
		this.missing -= data.length;
		if (this.sources.indexOf(source) === -1) {
			this.sources.push(source);
		}
	}
	return this.buffered === this.parts;
};

PieceBuffer.prototype.flush = function() {
	if (!this.buffer || this.parts !== this.buffered) return null;
	var buffer = Buffer.concat(this.buffer, this.length);
	this.buffer = null;
	this.cancellations = null;
	this.sources = null;
	this.flushed = true;
	return buffer;
};

PieceBuffer.prototype.init = function() {
	if (this.flushed) return false;
	if (this.buffer) return true;
	this.buffer = new Array(this.parts);
	this.cancellations = [];
	this.sources = [];
	return true;
};

module.exports = PieceBuffer;