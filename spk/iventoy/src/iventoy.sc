# iVentoy firewall ports for DSM Package Center
# Format: <port>/<protocol> <description>

# Network boot services (require root)
67/udp  DHCP Server
68/udp  DHCP Client
69/udp  TFTP Server
4011/udp ProxyDHCP
16000/tcp PXE HTTP (ISO serving)
10809/tcp NBD (Network Block Device)
3260/tcp iSCSI
12049/tcp NFS

# External Web UI via nginx reverse proxy (auth required)
# NOTE: iVentoy internal port 26000 is blocked by an iptables rule
# in service-setup.sh to force all traffic through this authenticated proxy.
26001/tcp iVentoy Web UI (nginx proxy + auth)