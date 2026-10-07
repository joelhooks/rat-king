export const storageMaintenanceScript = String.raw`import datetime
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = '/topics/.system/log'
MASTER = 'http://127.0.0.1:19333'
FILER = 'http://127.0.0.1:18888'
DAYS = 7
THRESHOLD = 8

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('storage diagnostic/retention refuses redirects')

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def request(url, method='GET'):
    req = urllib.request.Request(url, method=method, headers={'Accept': 'application/json'})
    with opener.open(req, timeout=30) as response:
        body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise RuntimeError('storage response too large')
        result = json.loads(body) if body else {}
        if result.get('error'):
            raise RuntimeError('storage request failed: ' + str(result['error']))
        return result

def retention(call=request, now=None):
    today = (now or datetime.datetime.now(datetime.timezone.utc)).date()
    cutoff = today - datetime.timedelta(days=DAYS)
    cursor = ''
    targets = []
    # Bound work and refuse incomplete or non-advancing listings before deleting.
    for _ in range(100):
        query = urllib.parse.urlencode({'limit': 1000, 'lastFileName': cursor})
        page = call(FILER + ROOT + '/?' + query)
        if page.get('Path') != ROOT or not isinstance(page.get('Entries'), (list, type(None))):
            raise RuntimeError('unexpected metadata log listing')
        for entry in page['Entries'] or []:
            path = entry.get('FullPath', '')
            if not isinstance(path, str) or not re.fullmatch(re.escape(ROOT) + r'/[0-9]{4}-[0-9]{2}-[0-9]{2}', path):
                continue
            mode = entry.get('Mode', 0)
            if not isinstance(mode, int) or not mode & (1 << 31):
                continue
            try:
                date = datetime.date.fromisoformat(path[len(ROOT) + 1:])
            except ValueError:
                continue
            if date < cutoff:
                targets.append(path)
        if page.get('ShouldDisplayLoadMore') is False:
            break
        next_cursor = page.get('LastFileName')
        if not isinstance(next_cursor, str) or next_cursor <= cursor:
            raise RuntimeError('non-advancing metadata log listing')
        cursor = next_cursor
    else:
        raise RuntimeError('metadata log listing exceeded page budget')
    for path in sorted(set(targets)):
        call(FILER + path + '?recursive=true', 'DELETE')
    return len(set(targets))

def diagnostic(call=request):
    topo = call(MASTER + '/dir/status')['Topology']
    free, maximum = topo['Free'], topo['Max']
    if type(free) is not int or type(maximum) is not int or maximum <= 0 or free < 0 or free > maximum:
        raise RuntimeError('invalid storage slot counters')
    layouts = topo['Layouts'] or []
    writable = set()
    for layout in layouts:
        # Match the metadata log's default collection / replication / no TTL.
        if layout['collection'] == '' and layout['replication'] == '000' and layout['ttl'] == '':
            for volume in layout['writables'] or []:
                if type(volume) is not int or volume <= 0:
                    raise RuntimeError('invalid writable volume id')
                writable.add(volume)
    return {'freeVolumeSlots': free, 'maxVolumeSlots': maximum,
            'defaultCollectionWritableVolumes': len(writable),
            'alarm': free < THRESHOLD or not writable,
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}

def main():
    if sys.argv[1:] not in (['retain'], ['diagnose']):
        raise RuntimeError('expected retain or diagnose')
    if sys.argv[1] == 'retain':
        print(json.dumps({'deletedLogDays': retention(), 'retentionDays': DAYS}), flush=True)
    signal = diagnostic()
    print(json.dumps(signal), flush=True)
    if not signal['defaultCollectionWritableVolumes']:
        print('storage has no writable volume in the default collection; node authority writes may fail', file=sys.stderr, flush=True)
    elif signal['freeVolumeSlots'] < THRESHOLD:
        print('storage free-volume slots below threshold 8', file=sys.stderr, flush=True)
    return 1 if signal['alarm'] else 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'alarm': True, 'diagnosticUnavailable': True, 'error': str(error)}), flush=True)
        sys.exit(1)
`;
