export const backupRecoveryScript = String.raw`
import pathlib, subprocess, sys
marker = pathlib.Path(sys.argv[1]) / '.mailbox-backup-restart-required'
if marker.exists():
    if marker.is_symlink() or not marker.is_file():
        raise RuntimeError('Invalid backup recovery marker')
    # Store first; each start waits for its unit's health gate.
    for unit in ['rat-king-seaweedfs.service', 'rat-king-celld.service']:
        subprocess.run(['systemctl', '--user', 'start', unit], check=True)
    marker.unlink()
    print('BACKUP_STOP_POST_RECOVERED')
`;
