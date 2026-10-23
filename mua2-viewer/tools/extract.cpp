// Decode the ISDone/FreeArc archive data block of MUA2's setup-1.bin:
//   4x4 stream (version 0; blocks: outSize,inSize,[1 + old-LZ4]) -> REP stream -> solid file data.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>
#include <sys/stat.h>
#include "codecs/Compression.h"
extern "C" {
#include "codecs/REP/C_REP.h"
}

extern "C" int LZ4_uncompress_unknownOutputSize(const char *source, char *dest, int isize, int maxOutputSize);

static const uint64_t kDataStart = 31;
static const uint64_t kDataSize  = 5356736951ULL;

struct FourXFour {
    FILE *f;
    uint64_t remaining;
    std::vector<uint8_t> in, out;
    size_t outPos = 0, outLen = 0;
    uint64_t totalOut = 0;
    int blocks = 0;

    FourXFour(const char *path) {
        f = fopen(path, "rb");
        if (!f) { perror("open"); exit(1); }
        fseeko(f, kDataStart, SEEK_SET);
        uint32_t version = 0;
        if (fread(&version, 4, 1, f) != 1 || version != 0) {
            fprintf(stderr, "bad 4x4 stream version %u\n", version);
            exit(1);
        }
        remaining = kDataSize - 4;
        in.resize(4 * 1024 * 1024);
        out.resize(4 * 1024 * 1024);
    }
    ~FourXFour() { if (f) fclose(f); }

    bool fill() {
        if (outPos < outLen) return true;
        if (remaining < 8) return false;
        uint32_t hdr[2];
        if (fread(hdr, 1, 8, f) != 8) return false;
        remaining -= 8;
        uint32_t outSize = hdr[0], inSize = hdr[1];
        if (inSize > remaining || inSize > in.size()) {
            fprintf(stderr, "bad block inSize=%u remaining=%llu\n", inSize, (unsigned long long)remaining);
            return false;
        }
        if (fread(in.data(), 1, inSize, f) != inSize) return false;
        remaining -= inSize;
        if (outSize == 0xffffffffu) {
            memcpy(out.data(), in.data(), inSize);
            outLen = inSize;
        } else {
            if (inSize < 1 || in[0] != 1) {
                fprintf(stderr, "block %d: bad lz4 version %d\n", blocks, inSize ? in[0] : -1);
                return false;
            }
            if (outSize > out.size()) out.resize(outSize);
            int r = LZ4_uncompress_unknownOutputSize((const char*)in.data() + 1,
                                                     (char*)out.data(), (int)inSize - 1, (int)outSize);
            if (r != (int)outSize) {
                fprintf(stderr, "block %d: lz4 -> %d (want %u), in=%u\n", blocks, r, outSize, inSize);
                return false;
            }
            outLen = outSize;
        }
        outPos = 0;
        totalOut += outLen;
        if ((++blocks % 500) == 0)
            fprintf(stderr, "4x4: %d blocks, %.1f GB decoded\n", blocks, totalOut / 1e9);
        return true;
    }

    size_t read(uint8_t *dst, size_t n) {
        size_t done = 0;
        while (done < n) {
            if (!fill()) break;
            size_t k = outLen - outPos;
            if (k > n - done) k = n - done;
            memcpy(dst + done, out.data() + outPos, k);
            outPos += k;
            done += k;
        }
        return done;
    }
};

struct Sink {
    FILE *f;
    uint64_t written = 0;
    explicit Sink(const char *path) {
        f = fopen(path, "wb");
        if (!f) { perror("create"); exit(1); }
        setvbuf(f, nullptr, _IOFBF, 8 * 1024 * 1024);
    }
    ~Sink() { if (f) fclose(f); }
    void write(const void *p, size_t n) {
        if (fwrite(p, 1, n, f) != n) { perror("write"); exit(1); }
        written += n;
        if ((written >> 30) != ((written - n) >> 30))
            fprintf(stderr, "out: %.2f GB\n", written / 1e9);
    }
};

struct Ctx { FourXFour *r; Sink *w; };

static int callback(const char *what, void *data, int size, void *aux) {
    Ctx *c = (Ctx*)aux;
    if (!strcmp(what, "read")) {
        return (int)c->r->read((uint8_t*)data, (size_t)size);
    } else if (!strcmp(what, "write")) {
        c->w->write(data, (size_t)size);
        return size;
    } else if (!strcmp(what, "progress")) {
        return 0;
    }
    return 0;
}

int main(int argc, char **argv) {
    const char *arc = argc > 1 ? argv[1] : "setup-1.bin";
    const char *out = argc > 2 ? argv[2] : "solid.bin";
    FourXFour r(arc);
    Sink w(out);
    Ctx ctx{&r, &w};
    // BlockSize etc. are read from the REP stream itself; the rest are decode-side defaults.
    int res = rep_decompress(0, 0, 0, 0, 0, 0, 0, 0, callback, &ctx);
    fprintf(stderr, "rep_decompress -> %d, 4x4 blocks=%d stream_out=%llu, written=%llu\n",
            res, r.blocks, (unsigned long long)r.totalOut, (unsigned long long)w.written);
    return res == 0 ? 0 : 1;
}
