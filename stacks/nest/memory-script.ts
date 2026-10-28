export const unitMemoryScript = String.raw`
def unit_memory(unit):
    report = {key: None for key in ['anon', 'file', 'current', 'max', 'peak']}
    try:
        result = subprocess.run(['systemctl', '--user', 'show', unit, '--property=ControlGroup,MemoryCurrent,MemoryMax,MemoryPeak'], capture_output=True, text=True, check=True, timeout=3)
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        for key, prop in [('current', 'MemoryCurrent'), ('max', 'MemoryMax'), ('peak', 'MemoryPeak')]:
            value = fields.get(prop, '')
            if value.isdecimal() and int(value) < 2**53:
                report[key] = int(value)
        group = fields.get('ControlGroup', '')
        if not group.startswith('/') or '..' in pathlib.PurePosixPath(group).parts:
            return report
        root = pathlib.Path('/sys/fs/cgroup') / group.lstrip('/')
        stats = dict(line.split() for line in (root / 'memory.stat').read_text().splitlines())
        for key in ['anon', 'file']:
            value = stats.get(key, '')
            if value.isdecimal() and int(value) < 2**53:
                report[key] = int(value)
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return report
`;
