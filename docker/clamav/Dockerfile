# ClamAV for Bike on Fly (fly.clamav.toml): the official image, listening on IPv6 as well, because apps reach
# each other over Fly's private network by IPv6 (bikeapp-clamav.internal:3310).
# ConcurrentDatabaseReload no: when the virus database updates (a few times a day), clamd reloads it in place
# instead of holding the old and the new one at once. The two together went past the machine's 2 GB and the system
# stopped clamd (Oct 30, 2026); scans now wait the few seconds a reload takes.
FROM clamav/clamav-debian:1.5.1
RUN echo "TCPAddr ::" >> /etc/clamav/clamd.conf \
  && echo "ConcurrentDatabaseReload no" >> /etc/clamav/clamd.conf
