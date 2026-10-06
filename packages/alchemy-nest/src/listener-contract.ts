export const storeListener = {
  address: "127.0.0.1",
  ports: {
    "filer.port": 18_888,
    "filer.port.grpc": 28_888,
    "master.port": 19_333,
    "master.port.grpc": 29_333,
    "s3.port": 18_333,
    "s3.port.grpc": 28_333,
    "volume.port": 18_081,
    "volume.port.grpc": 28_081,
  },
  unit: "rat-king-seaweedfs.service",
};

export const nodeListener = {
  internalAddress: "127.0.0.1",
  internalPort: 18_788,
  port: 18_787,
  unit: "rat-king-celld.service",
};

export const sidecarListener = {
  address: "127.0.0.1",
  port: 18_789,
  unit: "rat-king-claude-sidecar.service",
};

export const listenerUnits = [
  storeListener.unit,
  nodeListener.unit,
  sidecarListener.unit,
];

export const declaredListeners = (
  publicIPv4: string,
  nodeExpected: boolean,
  sidecarExpected: boolean
) => [
  ...Object.values(storeListener.ports).map((port) => ({
    address: storeListener.address,
    port,
    unit: storeListener.unit,
  })),
  ...(nodeExpected
    ? [
        {
          address: publicIPv4,
          port: nodeListener.port,
          unit: nodeListener.unit,
        },
        {
          address: nodeListener.internalAddress,
          port: nodeListener.internalPort,
          unit: nodeListener.unit,
        },
      ]
    : []),
  ...(sidecarExpected
    ? [
        {
          address: sidecarListener.address,
          port: sidecarListener.port,
          unit: sidecarListener.unit,
        },
      ]
    : []),
];
