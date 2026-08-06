import fs from 'fs'
import path from 'path'

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

function hasSupportedMagic(buffer: Buffer, extension: string): boolean {
    if (extension === '.jpg' || extension === '.jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    if (extension === '.png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    if (extension === '.gif') return buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a'
    if (extension === '.webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    return false
}
function isWithin(root: string, file: string): boolean {
    const relative = path.relative(root, file)
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export class ImageRepository {
    private constructor(private readonly images: string[]) {}

    static async open(directory: string): Promise<ImageRepository> {
        const configuredRoot = path.resolve(process.cwd(), directory)
        const rootStat = await fs.promises.lstat(configuredRoot).catch(() => null)
        if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return new ImageRepository([])

        const realRoot = await fs.promises.realpath(configuredRoot)
        const entries = await fs.promises.readdir(realRoot, { withFileTypes: true })
        const images: string[] = []

        for (const entry of entries) {
            if (!entry.isFile() || entry.isSymbolicLink()) continue
            const extension = path.extname(entry.name).toLowerCase()
            if (!EXTENSIONS.has(extension)) continue

            const candidate = path.join(realRoot, entry.name)
            const realCandidate = await fs.promises.realpath(candidate).catch(() => '')
            if (!realCandidate || !isWithin(realRoot, realCandidate)) continue

            const stat = await fs.promises.stat(realCandidate)
            if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) continue

            const handle = await fs.promises.open(realCandidate, 'r')
            try {
                const header = Buffer.alloc(16)
                const { bytesRead } = await handle.read(header, 0, header.length, 0)
                if (hasSupportedMagic(header.subarray(0, bytesRead), extension)) images.push(realCandidate)
            } finally {
                await handle.close()
            }
        }

        return new ImageRepository(images)
    }

    get size(): number {
        return this.images.length
    }

    pick(): string | null {
        if (this.images.length === 0) return null
        return this.images[Math.floor(Math.random() * this.images.length)] ?? null
    }
}
