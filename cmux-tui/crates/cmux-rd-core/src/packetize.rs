//! Splits one encoded frame into `cmux.rd/1` datagrams: data shards sized to
//! the session's `max_datagram`, then parity shards of the same size. A frame
//! of one shard without parity is not padded.

use cmux_rd_proto::{
    DatagramHeader, DatagramKind, FrameBody, HEADER_LEN, MAX_FRAME_SHARDS, fec_blocks,
};

use crate::fec::{self, FecError, MAX_SHARDS};

/// Packetizer state for one display stream.
#[derive(Debug, Clone)]
pub struct Packetizer {
    stream: u16,
    max_datagram: usize,
    next_transport_seq: u16,
    /// Shards go out as upstream media (rd change C4).
    upstream: bool,
    /// The viewer takes frames over one FEC block in several blocks (cap `fec.blocks`).
    fec_blocks: bool,
}

/// The datagrams of one frame, ready to send in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacketizedFrame {
    pub frame: u32,
    pub datagrams: Vec<Vec<u8>>,
    /// Transport sequence number of the first datagram (they are consecutive).
    pub first_transport_seq: u16,
    pub data_shards: u16,
    pub parity_shards: u16,
}

/// Why a frame cannot be packetized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacketizeError {
    /// The frame needs more than `MAX_FRAME_SHARDS` shards at this datagram size.
    FrameTooLarge,
    Fec(FecError),
}

impl Packetizer {
    /// `max_datagram` comes from the link (1152 or 1332 bytes); tests may use
    /// smaller values, never below 64.
    pub fn new(stream: u16, max_datagram: usize) -> Self {
        Self {
            stream,
            max_datagram: max_datagram.max(64),
            next_transport_seq: 0,
            upstream: false,
            fec_blocks: false,
        }
    }

    /// Payload bytes per shard.
    pub fn shard_len(&self) -> usize {
        self.max_datagram - HEADER_LEN
    }

    /// Reserves `n` transport sequence numbers for datagrams that are not
    /// frame shards (input acks, cursor, probes) and returns the first.
    pub fn reserve_transport_seq(&mut self, n: u16) -> u16 {
        let first = self.next_transport_seq;
        self.next_transport_seq = self.next_transport_seq.wrapping_add(n);
        first
    }

    /// The display stream the next frames belong to. One packetizer serves
    /// every stream of a peer, so transport sequence numbers stay one space
    /// for transport-wide feedback.
    pub fn set_stream(&mut self, stream: u16) {
        self.stream = stream;
    }

    /// Upstream mode (rd change C4): every shard, data and parity, goes out
    /// as `DatagramKind::UpMedia` (viewer to host media).
    pub fn set_upstream(&mut self, upstream: bool) {
        self.upstream = upstream;
    }

    /// Frames over one FEC block keep their parity, split across interleaved
    /// blocks: only when the viewer offered cap `fec.blocks` (an older viewer
    /// refuses such headers).
    pub fn set_fec_blocks(&mut self, on: bool) {
        self.fec_blocks = on;
    }

    /// Splits `body` into data shards plus `parity` parity shards.
    pub fn packetize(
        &mut self,
        frame: u32,
        flags: u8,
        body: &FrameBody,
        parity: usize,
    ) -> Result<PacketizedFrame, PacketizeError> {
        let bytes = body.encode();
        let shard_len = self.shard_len();
        let data_shards = bytes.len().div_ceil(shard_len).max(1);
        if data_shards > MAX_FRAME_SHARDS as usize {
            return Err(PacketizeError::FrameTooLarge);
        }
        // A frame larger than one FEC block (a big keyframe) is split across interleaved
        // blocks, each with at least one parity shard, when the viewer takes them (design
        // D6); else it keeps the parity that fits its one block (none past 254 data
        // shards) and NACKs and recovery cover the rest.
        let parity = if data_shards + parity <= MAX_SHARDS || parity == 0 {
            parity
        } else if self.fec_blocks {
            let parity = parity.min(data_shards).min(MAX_FRAME_SHARDS as usize);
            let blocks = fec_blocks(data_shards as u16, parity as u16);
            parity.max(blocks).min(data_shards)
        } else {
            MAX_SHARDS.saturating_sub(data_shards)
        };
        let blocks = if parity == 0 { 1 } else { fec_blocks(data_shards as u16, parity as u16) };
        let mut shards: Vec<Vec<u8>> = bytes.chunks(shard_len).map(<[u8]>::to_vec).collect();
        if shards.is_empty() {
            shards.push(Vec::new());
        }
        // Shards of one frame share one length (the reassembler refuses
        // others, and parity needs it); a lone shard keeps its own length, so a
        // small frame (an Opus packet, a key press) costs its bytes only, and its
        // parity (a copy, with one data shard) costs the same again.
        if shards.len() > 1
            && let Some(last) = shards.last_mut()
        {
            last.resize(shard_len, 0);
        }
        let parity_shards = if parity == 0 {
            Vec::new()
        } else {
            let refs: Vec<&[u8]> = shards.iter().map(Vec::as_slice).collect();
            fec::encode_blocks(&refs, parity, blocks).map_err(PacketizeError::Fec)?
        };
        let count = data_shards as u16;
        let fec_count = parity as u16;
        let first_transport_seq = self.reserve_transport_seq(count + fec_count);
        let datagrams = shards
            .iter()
            .chain(parity_shards.iter())
            .enumerate()
            .map(|(index, payload)| {
                let header = DatagramHeader {
                    flags,
                    kind: if self.upstream {
                        DatagramKind::UpMedia
                    } else if index < data_shards {
                        DatagramKind::Video
                    } else {
                        DatagramKind::Fec
                    },
                    stream: self.stream,
                    frame,
                    index: index as u16,
                    count,
                    fec_count,
                    transport_seq: first_transport_seq.wrapping_add(index as u16),
                };
                let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
                header.encode_into(&mut out);
                out.extend_from_slice(payload);
                out
            })
            .collect();
        Ok(PacketizedFrame {
            frame,
            datagrams,
            first_transport_seq,
            data_shards: count,
            parity_shards: fec_count,
        })
    }
}

/// The least parity share, on every path ([`fec_ratio`]).
pub const MIN_FEC_RATIO: f64 = 0.10;
/// The most parity share ([`fec_ratio`]).
pub const MAX_FEC_RATIO: f64 = 0.50;

/// The share of parity to data at a measured loss rate (0.0 to 1.0): twice the loss,
/// never under 10 %, so a lost datagram costs no round trip even before loss is measured,
/// and at most 50 % (design D10: loss raises redundancy; it never cuts the rate).
pub fn fec_ratio(loss: f64) -> f64 {
    let loss = if loss.is_finite() { loss } else { 0.0 };
    (loss * 2.0).clamp(MIN_FEC_RATIO, MAX_FEC_RATIO)
}

/// Parity shards for a frame of `data_shards` shards at a measured loss rate:
/// [`fec_ratio`] of its data shards, rounded up, so every frame has at least one. A
/// one-datagram frame (a key press's echo, a cursor blink) gets a parity copy: it leaves
/// no gap for the viewer to NACK, so its loss would otherwise wait for a tail probe. A
/// frame over one FEC block is split across blocks by [`Packetizer::packetize`] when the
/// viewer takes them (cap `fec.blocks`).
pub fn parity_for(data_shards: usize, loss: f64) -> usize {
    let n = (data_shards.max(1) as f64 * fec_ratio(loss)).ceil() as usize;
    n.clamp(1, MAX_FRAME_SHARDS as usize)
}
