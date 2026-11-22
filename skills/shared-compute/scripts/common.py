"""Shared wire format. Standard library only."""
import base64
import errno
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile

MAX_BYTES = 32 * 1024 * 1024
MAX_FILES = 10000
JOB_RE = re.compile(r"^[0-9a-f]{32}$")
DIAGNOSTIC_BYTES = 64 * 1024


def diagnostic_tail(value):
    """Bounded, untrusted diagnostics; remove terminal controls and obvious credentials."""
    if not isinstance(value, str):
        raise ValueError('Runner diagnostics must be text')
    # Bound processing before regexes. This is a heuristic, not a complete secret detector.
    value = value.encode('utf-8', 'replace')[-DIAGNOSTIC_BYTES:].decode('utf-8', 'replace')
    value = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', value)
    value = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', value)
    value = ''.join(c for c in value if c in '\n\t' or (ord(c) >= 32 and not 127 <= ord(c) <= 159))
    value = re.sub(r'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)', '[REDACTED PRIVATE KEY]', value)
    value = re.sub(r'(?:AKIA|ASIA)[A-Z0-9]{16}|(?:sk-(?:ant-|proj-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}', '[REDACTED TOKEN]', value)
    value = re.sub(r'(?i)((?:password|api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*)[^\s,;]+', r'\1[REDACTED]', value)
    return value.encode('utf-8', 'replace')[-DIAGNOSTIC_BYTES:].decode('utf-8', 'ignore')


def safe_name(name):
    p = PurePosixPath(name)
    if (not name or p.is_absolute() or str(p) != name or "\\" in name
            or any(c in name for c in ':\x00\r\n')
            or any(x in ('', '.', '..', '.git') for x in p.parts)
            or any(x.endswith((' ', '.')) or x.split('.')[0].upper() in
                   {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(10)),
                    *(f'LPT{i}' for i in range(10))} for x in p.parts)):
        raise ValueError(f"Unsafe relative path: {name!r}")
    return p


def regular_path(root, name):
    safe_name(name)
    root = Path(root).resolve()
    p = root
    for part in PurePosixPath(name).parts:
        p = p / part
        info = p.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f"Links/reparse points are forbidden: {name}")
    if not stat.S_ISREG(p.stat().st_mode) or not p.resolve().is_relative_to(root):
        raise ValueError(f"Not a regular contained file: {name}")
    return p


def read_regular(root, name, limit=MAX_BYTES):
    """Read through pinned no-follow handles; reject concurrent content changes.

    POSIX uses openat traversal. Windows pins every ancestor without delete
    sharing and opens the final reparse point itself without write sharing.
    """
    safe_name(name)
    root = Path(root).absolute()
    directories = []
    fd = None
    close_directory = os.close
    try:
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            import msvcrt
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                          wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
                                          wintypes.HANDLE)
            kernel.CreateFileW.restype = wintypes.HANDLE
            kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
            kernel.GetFileInformationByHandleEx.argtypes = (wintypes.HANDLE, ctypes.c_int,
                                                            wintypes.LPVOID, wintypes.DWORD)
            kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
            class Attributes(ctypes.Structure):
                _fields_ = [('attributes', wintypes.DWORD), ('tag', wintypes.DWORD)]
            def open_handle(path, directory):
                handle = kernel.CreateFileW(str(path), 0x80 if directory else 0x80000000,
                                            3 if directory else 1, None, 3,
                                            0x02200000, None)
                if handle == ctypes.c_void_p(-1).value:
                    raise ctypes.WinError(ctypes.get_last_error())
                attrs = Attributes()
                if not kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(attrs), ctypes.sizeof(attrs)):
                    error = ctypes.WinError(ctypes.get_last_error())
                    kernel.CloseHandle(handle)
                    raise error
                if attrs.attributes & 0x400 or bool(attrs.attributes & 0x10) != directory:
                    kernel.CloseHandle(handle)
                    raise ValueError(f'Link/reparse point or wrong file type: {name}')
                return handle
            close_directory = kernel.CloseHandle
            full = root / name
            if not full.drive or full.drive.startswith('\\\\'):
                raise ValueError('Windows snapshot reads require a local absolute drive path')
            directory = Path(full.anchor)
            directories.append(open_handle(directory, True))
            for part in full.parts[1:-1]:
                directory /= part
                directories.append(open_handle(directory, True))
            handle = open_handle(full, False)
            try:
                fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            except Exception:
                kernel.CloseHandle(handle)
                raise
        else:
            if not hasattr(os, 'O_NOFOLLOW') or not os.supports_dir_fd:
                raise ValueError('This runtime cannot perform safe no-follow reads')
            directories.append(os.open(root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
            for part in root.parts[1:]:
                directories.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                           dir_fd=directories[-1]))
            parts = PurePosixPath(name).parts
            for part in parts[:-1]:
                directories.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                           dir_fd=directories[-1]))
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=directories[-1])
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise ValueError('Not a regular file or file exceeds byte limit')
        chunks, length = [], 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > limit:
                raise ValueError('File exceeds byte limit')
        after = os.fstat(fd)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode')
        if any(getattr(before, f) != getattr(after, f) for f in fields) or length != before.st_size:
            raise ValueError('File changed while snapshotting; retry after writers finish')
        return b''.join(chunks), before
    except OSError as exc:
        if os.name != 'nt' and exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise ValueError(f'Link or unsafe directory at read boundary: {name}') from exc
        raise
    finally:
        if fd is not None:
            os.close(fd)
        for directory in reversed(directories):
            close_directory(directory)


def pack(files, modes=None):
    """files: relative name -> bytes; uncompressed tar bounds are also checked."""
    if len(files) > MAX_FILES or sum(map(len, files.values())) > MAX_BYTES:
        raise ValueError('Payload exceeds file/byte limit')
    out = io.BytesIO()
    manifest = []
    with tarfile.open(fileobj=out, mode='w:') as archive:
        for name, data in sorted(files.items()):
            safe_name(name)
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o700 if (modes or {}).get(name, 0) & 0o111 else 0o600
            archive.addfile(info, io.BytesIO(data))
            manifest.append({'path': name, 'size': len(data), 'mode': info.mode,
                             'sha256': hashlib.sha256(data).hexdigest()})
    raw = out.getvalue()
    if len(raw) > MAX_BYTES:
        raise ValueError('Archive exceeds byte limit')
    return {'archive': base64.b64encode(raw).decode(), 'manifest': manifest}


def unpack(payload, destination):
    """Validate the entire archive before creating anything."""
    raw = base64.b64decode(payload['archive'], validate=True)
    if len(raw) > MAX_BYTES or len(payload['manifest']) > MAX_FILES:
        raise ValueError('Payload exceeds limit')
    expected = {}
    for row in payload['manifest']:
        safe_name(row['path'])
        if row['path'] in expected:
            raise ValueError('Duplicate manifest path')
        expected[row['path']] = row
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        for member in archive:
            safe_name(member.name)
            if not member.isreg() or member.name in files or member.size > MAX_BYTES:
                raise ValueError('Unsafe archive member')
            data = archive.extractfile(member).read(MAX_BYTES + 1)
            total += len(data)
            row = expected.get(member.name)
            if (total > MAX_BYTES or len(files) >= MAX_FILES or row is None
                    or row['size'] != len(data)
                    or row.get('mode', 0o600) not in (0o600, 0o700)
                    or member.mode != row.get('mode', 0o600)
                    or row['sha256'] != hashlib.sha256(data).hexdigest()):
                raise ValueError('Manifest/hash/size mismatch')
            files[member.name] = data
    if files.keys() != expected.keys():
        raise ValueError('Archive/manifest file mismatch')
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError('Destination must be new')
    # Resolve parent before creation: a caller cannot redirect extraction via a link.
    destination = destination.parent.resolve(strict=True) / destination.name
    destination.mkdir(mode=0o700)
    try:
        for name, data in files.items():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(data)
            target.chmod(expected[name].get('mode', 0o600))
    except Exception:
        # Keep partial data for inspection; never pretend a failed fetch completed.
        raise
    return payload['manifest']


def atomic_json(path, data):
    path = Path(path)
    temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    with temp.open('x', encoding='utf-8') as stream:
        json.dump(data, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
