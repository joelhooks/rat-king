export const cacheIoScript = String.raw`
import os
CACHE_WINDOW = 8 * 1024 * 1024
COPY_CHUNK = 1024 * 1024
CACHE_PAGE = os.sysconf('SC_PAGESIZE')

def discard_cache(stream, start, end):
    # Linux ignores partial pages. Keep the last partial page for the next window.
    first = start - start % CACHE_PAGE
    last = end - end % CACHE_PAGE
    if last > first and hasattr(os, 'posix_fadvise'):
        os.posix_fadvise(stream.fileno(), first, last - first, os.POSIX_FADV_DONTNEED)
    return last

class CacheWriter:
    def __init__(self, stream):
        self.stream = stream
        self.synced = stream.tell()
    def tell(self):
        return self.stream.tell()
    def flush(self):
        self.stream.flush()
    def sync(self):
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.synced = discard_cache(self.stream, self.synced, self.stream.tell())
    def write(self, value):
        size, offset = len(value), 0
        while offset < size:
            remaining = CACHE_WINDOW - (self.stream.tell() - self.synced)
            length = min(size - offset, COPY_CHUNK, remaining)
            self.stream.write(memoryview(value)[offset:offset + length])
            offset += length
            if self.stream.tell() - self.synced >= CACHE_WINDOW:
                self.sync()
        return size

class CacheReader:
    def __init__(self, stream):
        self.stream = stream
        self.start = stream.tell()
    def tell(self):
        return self.stream.tell()
    def fileno(self):
        return self.stream.fileno()
    def release(self):
        self.start = discard_cache(self.stream, self.start, self.stream.tell())
    def seek(self, *args):
        self.release()
        position = self.stream.seek(*args)
        self.start = position
        return position
    def read(self, size=-1):
        value = self.stream.read(size)
        if self.stream.tell() - self.start >= CACHE_WINDOW or not value:
            self.release()
        return value
    def readable(self):
        return True
    def seekable(self):
        return self.stream.seekable()
    def __getattr__(self, name):
        return getattr(self.stream, name)

def cache_copy(source, destination):
    reader, writer = CacheReader(source), CacheWriter(destination)
    for chunk in iter(lambda: reader.read(COPY_CHUNK), b''):
        writer.write(chunk)
    reader.release()
    writer.sync()

def cache_tar(path):
    import contextlib
    @contextlib.contextmanager
    def opened():
        with path.open('rb') as stream:
            reader = CacheReader(stream)
            try:
                with tarfile.open(fileobj=reader) as archive:
                    yield archive
            finally:
                reader.release()
    return opened()
`;
