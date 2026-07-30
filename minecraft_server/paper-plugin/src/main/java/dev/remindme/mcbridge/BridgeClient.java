package dev.remindme.mcbridge;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * BridgeClient owns the Unix domain socket connection to the controller.
 *
 * <p>Everything here runs on one dedicated thread: connect, handshake, write. The
 * queue is small and drops the oldest sample when full, because a stale telemetry
 * sample is worthless and a growing queue on a Raspberry Pi is not.
 */
final class BridgeClient implements AutoCloseable {

    private static final int QUEUE_CAPACITY = 8;
    private static final long RECONNECT_DELAY_MS = 5_000L;

    private final Path socketPath;
    private final String token;
    private final Logger logger;
    private final BlockingQueue<String> queue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean ready = new AtomicBoolean(false);

    private Thread worker;

    BridgeClient(Path socketPath, String token, Logger logger) {
        this.socketPath = socketPath;
        this.token = token;
        this.logger = logger;
    }

    void start() {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        worker = new Thread(this::loop, "mcbridge-writer");
        worker.setDaemon(true);
        worker.start();
    }

    /** isReady reports whether a sample is worth collecting at all. */
    boolean isReady() {
        return ready.get();
    }

    /** enqueue never blocks the caller; the oldest pending sample is dropped instead. */
    void enqueue(String json) {
        if (!queue.offer(json)) {
            queue.poll();
            queue.offer(json);
        }
    }

    private void loop() {
        while (running.get()) {
            try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
                channel.connect(UnixDomainSocketAddress.of(socketPath));
                OutputStream out = Channels.newOutputStream(channel);
                BufferedReader in = new BufferedReader(
                        new InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8));

                String hello = "{\"token\":\"" + Json.escape(token)
                        + "\",\"plugin_version\":\"mcbridge\",\"server_version\":\""
                        + Json.escape(org.bukkit.Bukkit.getVersion()) + "\"}\n";
                out.write(hello.getBytes(StandardCharsets.UTF_8));
                out.flush();

                String response = in.readLine();
                if (response == null || !response.contains("\"ok\":true")) {
                    logger.warning("The add-on controller rejected the bridge handshake; check the token file");
                    sleep(RECONNECT_DELAY_MS * 4);
                    continue;
                }
                ready.set(true);
                logger.info("Connected to the add-on controller");

                while (running.get()) {
                    String sample = queue.poll(5, TimeUnit.SECONDS);
                    if (sample == null) {
                        continue;
                    }
                    out.write(sample.getBytes(StandardCharsets.UTF_8));
                    out.write('\n');
                    out.flush();
                }
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return;
            } catch (IOException ex) {
                if (running.get()) {
                    logger.log(Level.FINE, "Bridge connection lost, retrying", ex);
                }
            } finally {
                ready.set(false);
            }
            sleep(RECONNECT_DELAY_MS);
        }
    }

    private void sleep(long millis) {
        if (!running.get()) {
            return;
        }
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public void close() {
        running.set(false);
        ready.set(false);
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
    }
}
