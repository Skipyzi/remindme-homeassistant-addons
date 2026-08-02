package dev.remindme.mcbridge;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.logging.Level;

import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

/**
 * McBridge pushes telemetry the add-on cannot scrape from the console - TPS,
 * MSPT, JVM heap, loaded chunks and entity counts - to the controller.
 *
 * <p>Design constraints that shaped this plugin:
 * <ul>
 *   <li>It opens no network port. The plugin dials a Unix domain socket that the
 *       controller owns inside {@code /data}, so nothing is reachable from the LAN.</li>
 *   <li>It authenticates with a token the controller generates with 0600
 *       permissions, so another process on the host cannot impersonate a server.</li>
 *   <li>Bukkit state is only read on the main thread; the socket write happens on
 *       an async task, so a slow or dead socket can never stall a tick.</li>
 * </ul>
 */
public final class McBridgePlugin extends JavaPlugin {

    private static final long SAMPLE_INTERVAL_TICKS = 20L; // one second

    private BridgeClient client;
    private TelemetryCollector collector;
    private BukkitTask sampleTask;

    @Override
    public void onEnable() {
        String socketPath = System.getenv("MCBRIDGE_SOCKET");
        String tokenFile = System.getenv("MCBRIDGE_TOKEN_FILE");

        if (socketPath == null || socketPath.isBlank() || tokenFile == null || tokenFile.isBlank()) {
            getLogger().warning("MCBRIDGE_SOCKET or MCBRIDGE_TOKEN_FILE is not set; "
                    + "this plugin only works when the server is launched by the Home Assistant add-on. Staying idle.");
            return;
        }

        String token;
        try {
            token = Files.readString(Path.of(tokenFile)).trim();
        } catch (Exception ex) {
            getLogger().log(Level.WARNING, "Could not read the bridge token; telemetry is disabled", ex);
            return;
        }
        if (token.isEmpty()) {
            getLogger().warning("The bridge token file is empty; telemetry is disabled");
            return;
        }

        collector = new TelemetryCollector(getServer(), getDescription().getVersion());
        client = new BridgeClient(Path.of(socketPath), token, getLogger());
        client.start();

        // Sampling runs on the main thread because Bukkit collections are not
        // thread safe; the sample is handed to the writer thread as a finished
        // string, so the tick never waits for I/O.
        sampleTask = getServer().getScheduler().runTaskTimer(this, () -> {
            if (!client.isReady()) {
                return;
            }
            client.enqueue(collector.sample());
        }, SAMPLE_INTERVAL_TICKS, SAMPLE_INTERVAL_TICKS);

        getLogger().info("Management bridge enabled, pushing telemetry every second");
    }

    @Override
    public void onDisable() {
        if (sampleTask != null) {
            sampleTask.cancel();
            sampleTask = null;
        }
        if (client != null) {
            client.close();
            client = null;
        }
    }
}
