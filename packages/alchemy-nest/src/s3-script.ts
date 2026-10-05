export const s3Script = String.raw`
import concurrent.futures, datetime, hashlib, hmac, http.client, json, sys, threading, urllib.parse, uuid, xml.etree.ElementTree as ET
config, endpoint, bucket, operation = sys.argv[1:5]
with open(config) as f:
    credential = json.load(f)['identities'][0]['credentials'][0]
access, secret = credential['accessKey'], credential['secretKey']
base = urllib.parse.urlsplit(endpoint)

def request(method, key='', query='', conditional=False):
    path = '/' + bucket + ('/' + urllib.parse.quote(key, safe='/~') if key else '')
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    payload = b'proof' if method == 'PUT' and key else b''
    hashed = hashlib.sha256(payload).hexdigest()
    headers = {'host': base.netloc, 'x-amz-content-sha256': hashed, 'x-amz-date': stamp}
    if conditional:
        headers['if-none-match'] = '*'
    names = sorted(headers)
    signed = ';'.join(names)
    canonical = '\n'.join([method, path, query, ''.join(n + ':' + headers[n] + '\n' for n in names), signed, hashed])
    scope = day + '/us-east-1/s3/aws4_request'
    string = '\n'.join(['AWS4-HMAC-SHA256', stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = ('AWS4' + secret).encode()
    for value in [day, 'us-east-1', 's3', 'aws4_request']:
        k = hmac.new(k, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(k, string.encode(), hashlib.sha256).hexdigest()
    headers['authorization'] = 'AWS4-HMAC-SHA256 Credential=' + access + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature
    connection = http.client.HTTPConnection(base.hostname, base.port, timeout=30)
    try:
        connection.request(method, path + ('?' + query if query else ''), payload, headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()

if operation == 'race':
    key = 'rat-king-probe/' + str(uuid.uuid4())
    barrier = threading.Barrier(50)
    def put(_):
        barrier.wait(timeout=30)
        return request('PUT', key, conditional=True)[0]
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=50) as pool:
            codes = list(pool.map(put, range(50)))
        print(json.dumps({'winners': codes.count(200), 'preconditions': codes.count(412), 'statuses': codes}))
    finally:
        status, _ = request('DELETE', key)
        if status != 204:
            raise RuntimeError('probe key cleanup failed')
elif operation == 'purge':
    token = ''
    while True:
        parameters = {'list-type': '2', 'max-keys': '1000'}
        if token:
            parameters['continuation-token'] = token
        query = urllib.parse.urlencode(sorted(parameters.items()), quote_via=urllib.parse.quote, safe='~')
        status, body = request('GET', query=query)
        if status == 404:
            break
        if status != 200:
            raise RuntimeError('bucket listing failed')
        page = ET.fromstring(body)
        for item in page.findall('./{*}Contents/{*}Key'):
            code, _ = request('DELETE', item.text or '')
            if code not in (204, 404):
                raise RuntimeError('owned object deletion failed')
        if page.findtext('./{*}IsTruncated', 'false') != 'true':
            break
        continuation = page.findtext('./{*}NextContinuationToken', '')
        if not continuation or continuation == token:
            raise RuntimeError('invalid listing cursor')
        token = continuation
    status, _ = request('DELETE')
    print(json.dumps({'status': status, 'version': ''}))
else:
    method = {'read': 'HEAD', 'create': 'PUT', 'delete': 'DELETE', 'version': 'GET', 'pointer': 'HEAD'}[operation]
    status, body = request(method, key='deploy/current.json' if operation == 'pointer' else '', query='versioning=' if operation == 'version' else '')
    version = ''
    if operation == 'version' and status == 200:
        root = ET.fromstring(body)
        version = next((item.text or '' for item in root.iter() if item.tag.split('}')[-1] == 'Status'), '')
    print(json.dumps({'status': status, 'version': version}))
`;
