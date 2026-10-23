// Extract Zoe Mode / Alchemy .bin archives (MUA1/MUA2 PC 2016).
// Header: magic 0x6ECA9AB1, ver, zip, files, infoZ, namesSize, namesZ, dummy
// Index entry (0x28): dummy u64, nameOff u64, offset u64, zsize u64, size u64
// Blocks are XOR-encrypted with an LCG keyed by their compressed size, then zlib.
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
#include <filesystem>
#include <zlib.h>

namespace fs = std::filesystem;

struct Entry {
    uint64_t dummy, nameOff, offset, zsize, size;
};

static uint32_t key_seed(uint64_t compSize) {
    uint32_t tmp = (uint32_t)(uint16_t)((compSize + 85) & 0xffff);
    if (tmp & 0x8000) tmp |= 0xffff0000u;
    return ((tmp | (tmp << 16)) ^ 0x3B9A1D9u) & 0x0FFFFFFFu;
}

static void decrypt(std::vector<uint8_t>& data) {
    uint32_t m = key_seed(data.size());
    size_t n = data.size();
    size_t words = n / 4;  // the last (n % 4) bytes are not keyed
    std::vector<uint8_t> key(words * 4);
    for (size_t i = 0; i < words; i++) {
        m = (0x3FDu * m + 1u) & 0x0FFFFFFFu;
        memcpy(&key[i * 4], &m, 4);
    }
    for (size_t i = 0; i < key.size(); i++) data[i] ^= key[i];
}

static bool read_file_at(FILE* f, uint64_t off, size_t n, std::vector<uint8_t>& out) {
    out.resize(n);
    if (fseeko(f, (off_t)off, SEEK_SET) != 0) return false;
    return fread(out.data(), 1, n, f) == n;
}

static bool inflate_block(std::vector<uint8_t>& in, size_t outSize, std::vector<uint8_t>& out) {
    decrypt(in);
    out.resize(outSize);
    uLongf destLen = outSize;
    int r = uncompress(out.data(), &destLen, in.data(), in.size());
    if (r != Z_OK) {
        fprintf(stderr, "  zlib error %d (in=%zu out=%zu)\n", r, in.size(), outSize);
        return false;
    }
    if (destLen != outSize) {
        out.resize(destLen);
    }
    return true;
}

static uint64_t rd64(const uint8_t* p) { uint64_t v; memcpy(&v, p, 8); return v; }
static uint32_t rd32(const uint8_t* p) { uint32_t v; memcpy(&v, p, 4); return v; }
static uint16_t rd16(const uint8_t* p) { uint16_t v; memcpy(&v, p, 2); return v; }

static std::string sanitize(const std::string& s) {
    std::string out;
    for (char c : s) {
        if (c == '\\') out += '/';
        else out += c;
    }
    while (!out.empty() && (out[0] == '/' || out[0] == '.')) out.erase(out.begin());
    return out.empty() ? "unnamed.bin" : out;
}

int main(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s <archive.bin> <outdir> [filter-substring]\n", argv[0]);
        return 1;
    }
    FILE* f = fopen(argv[1], "rb");
    if (!f) { perror(argv[1]); return 1; }
    uint8_t hdr[0x1C];
    if (fread(hdr, 1, sizeof hdr, f) != sizeof hdr) { fprintf(stderr, "short header\n"); return 1; }
    if (rd32(hdr) != 0xB19ACA6Eu) { fprintf(stderr, "bad magic %08x\n", rd32(hdr)); return 1; }
    uint16_t ver = rd16(hdr + 4);
    uint16_t zip = rd16(hdr + 6);
    uint32_t files = rd32(hdr + 8);
    uint32_t infoZ = rd32(hdr + 12);
    uint32_t namesSize = rd32(hdr + 16);
    uint32_t namesZ = rd32(hdr + 20);
    fprintf(stderr, "%s: ver=%u zip=%u files=%u infoZ=%u names=%u/%u\n",
            argv[1], ver, zip, files, infoZ, namesSize, namesZ);

    std::vector<uint8_t> idxRaw, idx, namesRaw, names;
    if (!read_file_at(f, 0x1C, infoZ, idxRaw)) return 1;
    if (!inflate_block(idxRaw, (size_t)files * 0x28, idx)) { fprintf(stderr, "index inflate failed\n"); return 1; }
    if (!read_file_at(f, 0x1C + (uint64_t)infoZ, namesZ, namesRaw)) return 1;
    if (!inflate_block(namesRaw, namesSize, names)) { fprintf(stderr, "names inflate failed\n"); return 1; }

    uint64_t base = 0x1C + (uint64_t)infoZ + namesZ;
    fs::path outdir(argv[2]);
    const char* filter = argc > 3 ? argv[3] : nullptr;
    uint64_t total = 0;
    for (uint32_t i = 0; i < files; i++) {
        const uint8_t* e = idx.data() + (size_t)i * 0x28;
        Entry en{rd64(e), rd64(e + 8), rd64(e + 16), rd64(e + 24), rd64(e + 32)};
        if (en.nameOff >= names.size()) { fprintf(stderr, "entry %u: bad name offset\n", i); continue; }
        std::string name((const char*)names.data() + en.nameOff);
        if (filter && name.find(filter) == std::string::npos) continue;
        std::string rel = sanitize(name);
        fs::path out = outdir / rel;
        if (en.size == 0) continue;
        std::vector<uint8_t> comp, data;
        if (!read_file_at(f, base + en.offset, en.zsize, comp)) { fprintf(stderr, "read fail %s\n", name.c_str()); continue; }
        if (!inflate_block(comp, en.size, data)) {
            fprintf(stderr, "  failed: %s\n", name.c_str());
            continue;
        }
        fs::create_directories(out.parent_path());
        FILE* o = fopen(out.c_str(), "wb");
        if (!o) { perror(out.c_str()); continue; }
        fwrite(data.data(), 1, data.size(), o);
        fclose(o);
        total += data.size();
        if ((i + 1) % 500 == 0) fprintf(stderr, "  %u/%u files (%.1f MB)\n", i + 1, files, total / 1e6);
    }
    fprintf(stderr, "done: %.2f MB\n", total / 1e6);
    fclose(f);
    return 0;
}
