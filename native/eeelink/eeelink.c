// eeelink: TCP over the USB cable between the Eee Note and the Mac, without IP.
//
// The tablet's USB controller offers Ethernet only as RNDIS, which macOS cannot drive, and
// its CDC-ACM serial mode stalls macOS's serial driver when the port is opened. What works is
// g_serial in plain bulk mode (use_acm=0): macOS leaves it alone, the Mac side claims the bulk
// endpoints with libusb, and the tablet side reads and writes /dev/ttyGS0.
//
// Both ends multiplex TCP connections over that byte stream in frames:
//   0xEE, type, channel (u16 BE), length (u16 BE), payload
// OPEN carries the port to connect to at the other end, DATA carries bytes, CLOSE ends a
// channel. Channels the tablet opens have the high bit clear, the Mac's have it set.
//
// g_serial has no flow control towards the tablet: it hands every packet to the tty, whose
// buffers hold about 64 KB, and drops what does not fit. So the tablet ACKs the bytes it has
// read (channel 0, a u32 BE count), and the Mac keeps at most WINDOW bytes unacknowledged.
//
// The cable comes and goes without the tablet's tty noticing, so the Mac starts every link
// with RESET, which drops the tablet's channels from before, and the tablet gives a link up
// when a packet does not go out within LINK_TIMEOUT.
//
//   tablet:  eeelink [listen-port:remote-port ...]      default 8770:8770  (app -> hub)
//   mac:     eeelink [listen-port:remote-port ...]      default 2323:23    (telnet over USB)
//
// Built with -DEEELINK_HOST for the Mac (libusb), without it for the tablet.

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

#ifdef EEELINK_HOST
#include <libusb-1.0/libusb.h>
#include <pthread.h>
#endif

enum { OPEN = 1, DATA = 2, CLOSE = 3, ACK = 4, RESET = 5 };
#define MAGIC 0xEE
#define MAX_CHANNELS 64
#define MAX_FORWARDS 8
#define MAX_PAYLOAD 4096
#define WINDOW (32 * 1024)
#define ACK_EVERY (8 * 1024)

struct channel { int id, fd; };
struct forward { int listen_port, remote_port, fd; };

static struct channel channels[MAX_CHANNELS];
static struct forward forwards[MAX_FORWARDS];
static int forward_count = 0;
static int next_channel = 1;

static int in_flight = 0;   // Mac: bytes sent that the tablet has not ACKed yet
static int unacked = 0;     // tablet: bytes read that it has not ACKed yet

static int link_dead = 0;    // a write to the other side failed; serve() gives the link up

static int debug = 0;
static void logf_(const char *msg, int a) { fprintf(stderr, "eeelink: %s %d\n", msg, a); }
static void trace(const char *what, int id, int n) { if (debug) fprintf(stderr, "eeelink: %s channel %d, %d bytes\n", what, id, n); }

// ── Link: the byte stream to the other side ────────────────────────────────

#ifdef EEELINK_HOST
static libusb_context *usb;
static libusb_device_handle *dev;
static unsigned char ep_in, ep_out;
static int link_pipe[2];            // the USB reader thread writes received bytes here
static volatile int reader_stop = 0;
static pthread_mutex_t write_lock = PTHREAD_MUTEX_INITIALIZER;

static int link_open(void) {
    // After a replug the list can still hold the device that went away next to the new one.
    libusb_device **list;
    ssize_t n = libusb_get_device_list(usb, &list);
    int ok = 0;
    for (ssize_t i = 0; i < n && !ok; i++) {
        struct libusb_device_descriptor d;
        libusb_get_device_descriptor(list[i], &d);
        ok = d.idVendor == 0x0525 && d.idProduct == 0xa4a6 && libusb_open(list[i], &dev) == 0;
    }
    libusb_free_device_list(list, 1);
    if (!ok) return -1;
    libusb_set_configuration(dev, 1);
    struct libusb_config_descriptor *c;
    if (libusb_get_active_config_descriptor(libusb_get_device(dev), &c)) { libusb_close(dev); return -1; }
    int iface = -1;
    for (int i = 0; i < c->bNumInterfaces; i++) {
        const struct libusb_interface_descriptor *a = &c->interface[i].altsetting[0];
        for (int e = 0; e < a->bNumEndpoints; e++) {
            const struct libusb_endpoint_descriptor *ep = &a->endpoint[e];
            if ((ep->bmAttributes & 3) != LIBUSB_TRANSFER_TYPE_BULK) continue;
            iface = a->bInterfaceNumber;
            if (ep->bEndpointAddress & 0x80) ep_in = ep->bEndpointAddress; else ep_out = ep->bEndpointAddress;
        }
    }
    libusb_free_config_descriptor(c);
    int r = iface < 0 ? -1 : libusb_claim_interface(dev, iface);
    static int last_error = 0;
    if (r && r != last_error) logf_("cannot claim the device", r);
    last_error = r;
    if (r) {
        libusb_close(dev);
        return -1;
    }
    return 0;
}

static void *usb_reader(void *arg) {
    (void)arg;
    unsigned char buf[4096];
    while (!reader_stop) {
        int got = 0;
        int r = libusb_bulk_transfer(dev, ep_in, buf, sizeof buf, &got, 1000);
        if (got > 0) write(link_pipe[1], buf, got);
        if (r != 0 && r != LIBUSB_ERROR_TIMEOUT) break;
    }
    close(link_pipe[1]);
    return NULL;
}

static int link_read_fd(void) { return link_pipe[0]; }

static int link_write(const unsigned char *buf, int len) {
    pthread_mutex_lock(&write_lock);
    int off = 0;
    while (off < len) {
        int sent = 0;
        int r = libusb_bulk_transfer(dev, ep_out, (unsigned char *)buf + off, len - off, &sent, 5000);
        off += sent;
        if (r != 0) { pthread_mutex_unlock(&write_lock); link_dead = 1; return -1; }
    }
    pthread_mutex_unlock(&write_lock);
    return 0;
}
#else
static int tty = -1;

static int link_open(void) {
    tty = open("/dev/ttyGS0", O_RDWR | O_NOCTTY);
    if (tty < 0) return -1;
    struct termios t;
    tcgetattr(tty, &t);
    cfmakeraw(&t);
    tcsetattr(tty, TCSANOW, &t);
    return 0;
}

static int link_read_fd(void) { return tty; }

// The tablet's USB controller (pxa3xx_udc) sends a queued IN packet late when several are
// queued at once: a 64-byte packet of a longer message arrives after the ones behind it. So
// the tablet writes one full-speed packet at a time and waits for it to go out before the next.
#define PACKET 64

#define LINK_TIMEOUT 3

// SIGALRM interrupts a write or tcdrain that waits for a Mac that is gone.
static volatile sig_atomic_t timed_out = 0;
static void on_alarm(int sig) { (void)sig; timed_out = 1; }

static int link_write(const unsigned char *buf, int len) {
    int off = 0;
    while (off < len && !link_dead) {
        timed_out = 0;
        alarm(LINK_TIMEOUT);
        int n = write(tty, buf + off, len - off < PACKET ? len - off : PACKET);
        if (n > 0 && tcdrain(tty) == 0) off += n;
        else if (timed_out || (n < 0 && errno != EINTR && errno != EAGAIN)) link_dead = 1;
        alarm(0);
    }
    return link_dead ? -1 : 0;
}
#endif

static int send_frame(int type, int id, const unsigned char *payload, int len) {
    trace(type == OPEN ? "send OPEN" : type == DATA ? "send DATA" : type == CLOSE ? "send CLOSE" : "send control", id, len);
    unsigned char frame[6 + MAX_PAYLOAD] = { MAGIC, (unsigned char)type, (unsigned char)(id >> 8), (unsigned char)id,
                                             (unsigned char)(len >> 8), (unsigned char)len };
    if (len) memcpy(frame + 6, payload, len);
#ifdef EEELINK_HOST
    in_flight += 6 + len;
#endif
    return link_write(frame, 6 + len);
}

// ── Channels ────────────────────────────────────────────────────────────────

static struct channel *find(int id) {
    for (int i = 0; i < MAX_CHANNELS; i++) if (channels[i].fd >= 0 && channels[i].id == id) return &channels[i];
    return NULL;
}

static struct channel *add(int id, int fd) {
    for (int i = 0; i < MAX_CHANNELS; i++) {
        if (channels[i].fd < 0) { channels[i].id = id; channels[i].fd = fd; return &channels[i]; }
    }
    close(fd);
    return NULL;
}

static void drop(struct channel *c, int tell) {
    if (!c || c->fd < 0) return;
    if (tell) send_frame(CLOSE, c->id, NULL, 0);
    close(c->fd);
    c->fd = -1;
}

static int connect_local(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { close(fd); return -1; }
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    return fd;
}

static int listen_local(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(fd, (struct sockaddr *)&a, sizeof a) < 0 || listen(fd, 16) < 0) { close(fd); return -1; }
    return fd;
}

// ── Frames from the other side ──────────────────────────────────────────────

static unsigned char inbuf[2 * (MAX_PAYLOAD + 6)];
static int inlen = 0;

static void handle_frame(int type, int id, const unsigned char *p, int len) {
    trace(type == OPEN ? "got OPEN" : type == DATA ? "got DATA" : "got CLOSE", id, len);
    if (type == OPEN && len == 2) {
        int fd = connect_local((p[0] << 8) | p[1]);
        if (fd < 0 || !add(id, fd)) send_frame(CLOSE, id, NULL, 0);
    } else if (type == DATA) {
        struct channel *c = find(id);
        if (!c) return;
        int off = 0;
        while (off < len) {
            int n = write(c->fd, p + off, len - off);
            if (n <= 0) { drop(c, 1); return; }
            off += n;
        }
    } else if (type == CLOSE) {
        drop(find(id), 0);
    } else if (type == RESET) {
        for (int i = 0; i < MAX_CHANNELS; i++) drop(&channels[i], 0);
        unacked = 0;
    } else if (type == ACK && len == 4) {
        in_flight -= (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
        if (in_flight < 0) in_flight = 0;
    }
}

// Returns -1 when the link is gone.
static int pump_link(void) {
    int n = read(link_read_fd(), inbuf + inlen, sizeof inbuf - inlen);
    if (n <= 0) return -1;
    inlen += n;
#ifndef EEELINK_HOST
    unacked += n;
    if (unacked >= ACK_EVERY) {
        unsigned char count[4] = { (unsigned char)(unacked >> 24), (unsigned char)(unacked >> 16),
                                   (unsigned char)(unacked >> 8), (unsigned char)unacked };
        unacked = 0;
        if (send_frame(ACK, 0, count, 4)) return -1;
    }
#endif
    int off = 0;
    while (inlen - off >= 6) {
        if (inbuf[off] != MAGIC) { off++; continue; }
        int len = (inbuf[off + 4] << 8) | inbuf[off + 5];
        if (len > MAX_PAYLOAD) { off++; continue; }
        if (inlen - off < 6 + len) break;
        handle_frame(inbuf[off + 1], (inbuf[off + 2] << 8) | inbuf[off + 3], inbuf + off + 6, len);
        off += 6 + len;
    }
    memmove(inbuf, inbuf + off, inlen - off);
    inlen -= off;
    return 0;
}

static void serve(void) {
    for (int i = 0; i < MAX_CHANNELS; i++) channels[i].fd = -1;
    while (!link_dead) {
        fd_set rd;
        FD_ZERO(&rd);
        int top = link_read_fd();
        FD_SET(top, &rd);
        for (int i = 0; i < forward_count; i++) {
            FD_SET(forwards[i].fd, &rd);
            if (forwards[i].fd > top) top = forwards[i].fd;
        }
        int room = in_flight + 6 + MAX_PAYLOAD <= WINDOW;
        for (int i = 0; i < MAX_CHANNELS; i++) {
            if (channels[i].fd < 0 || !room) continue;
            FD_SET(channels[i].fd, &rd);
            if (channels[i].fd > top) top = channels[i].fd;
        }
        if (select(top + 1, &rd, NULL, NULL, NULL) < 0) { if (errno == EINTR) continue; return; }

        if (FD_ISSET(link_read_fd(), &rd) && pump_link() < 0) return;
        for (int i = 0; i < forward_count; i++) {
            if (!FD_ISSET(forwards[i].fd, &rd)) continue;
            int fd = accept(forwards[i].fd, NULL, NULL);
            if (fd < 0) continue;
#ifdef EEELINK_HOST
            int id = 0x8000 | (next_channel++ & 0x7fff);
#else
            int id = next_channel++ & 0x7fff;
#endif
            unsigned char port[2] = { (unsigned char)(forwards[i].remote_port >> 8), (unsigned char)forwards[i].remote_port };
            if (add(id, fd)) send_frame(OPEN, id, port, 2);
        }
        unsigned char buf[MAX_PAYLOAD];
        for (int i = 0; i < MAX_CHANNELS; i++) {
            if (channels[i].fd < 0 || !FD_ISSET(channels[i].fd, &rd)) continue;
            if (in_flight + 6 + MAX_PAYLOAD > WINDOW) break;
            int n = read(channels[i].fd, buf, sizeof buf);
            if (n <= 0) drop(&channels[i], 1);
            else if (send_frame(DATA, channels[i].id, buf, n)) return;
        }
    }
}

static void reset_channels(void) {
    for (int i = 0; i < MAX_CHANNELS; i++) if (channels[i].fd >= 0) { close(channels[i].fd); channels[i].fd = -1; }
    inlen = 0;
    in_flight = 0;
    unacked = 0;
    link_dead = 0;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
#ifndef EEELINK_HOST
    struct sigaction alarm_action;
    memset(&alarm_action, 0, sizeof alarm_action);
    alarm_action.sa_handler = on_alarm;
    sigaction(SIGALRM, &alarm_action, NULL);
#endif
    debug = getenv("EEELINK_DEBUG") != NULL;
#ifdef EEELINK_HOST
    const char *defaults[] = { "2323:23" };
#else
    const char *defaults[] = { "8770:8770" };
#endif
    int count = argc > 1 ? argc - 1 : 1;
    for (int i = 0; i < count && forward_count < MAX_FORWARDS; i++) {
        const char *spec = argc > 1 ? argv[i + 1] : defaults[i];
        struct forward *f = &forwards[forward_count];
        if (sscanf(spec, "%d:%d", &f->listen_port, &f->remote_port) != 2) continue;
        f->fd = listen_local(f->listen_port);
        if (f->fd < 0) { logf_("cannot listen on port", f->listen_port); return 1; }
        forward_count++;
    }
#ifdef EEELINK_HOST
    libusb_init(&usb);
#endif
    // Wait for the other side, serve until the link drops, then wait again: the cable comes
    // and goes, and the tablet's gadget driver is only there while its app runs.
    for (;;) {
        if (link_open() < 0) { sleep(2); continue; }
        logf_("link up", 0);
#ifdef EEELINK_HOST
        pipe(link_pipe);
        reader_stop = 0;
        pthread_t reader;
        pthread_create(&reader, NULL, usb_reader, NULL);
        send_frame(RESET, 0, NULL, 0);
        in_flight = 0;
        serve();
        reader_stop = 1;
        pthread_join(reader, NULL);
        libusb_close(dev);
        close(link_pipe[0]);
#else
        serve();
        tcflush(tty, TCIOFLUSH);
        close(tty);
#endif
        reset_channels();
        logf_("link down", 0);
        sleep(1);
    }
}
