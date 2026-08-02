package dev.remindme.mcbridge;

import java.util.ArrayList;
import java.util.List;

import org.bukkit.Server;
import org.bukkit.World;
import org.bukkit.entity.Player;

/**
 * TelemetryCollector reads server state and renders it as one JSON line.
 *
 * <p>Called on the main thread once per second. Everything it touches is cheap:
 * counters Paper already maintains, plus the player list. Entity counts come from
 * {@code World#getEntityCount()} where available, which is a counter rather than a
 * collection copy.
 */
final class TelemetryCollector {

    private final Server server;
    private final String pluginVersion;
    private final boolean hasEntityCount;

    TelemetryCollector(Server server, String pluginVersion) {
        this.server = server;
        this.pluginVersion = pluginVersion;
        this.hasEntityCount = methodExists(World.class, "getEntityCount");
    }

    String sample() {
        Runtime runtime = Runtime.getRuntime();
        long heapMaxMb = runtime.maxMemory() / (1024 * 1024);
        long heapUsedMb = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024);

        List<String> players = new ArrayList<>();
        for (Player player : server.getOnlinePlayers()) {
            players.add(player.getName());
        }

        long totalChunks = 0;
        long totalEntities = 0;
        StringBuilder worlds = new StringBuilder("{");
        boolean first = true;
        for (World world : server.getWorlds()) {
            long chunks = world.getLoadedChunks().length;
            long entities = entityCount(world);
            totalChunks += chunks;
            totalEntities += entities;
            if (!first) {
                worlds.append(',');
            }
            first = false;
            worlds.append('"').append(Json.escape(world.getName())).append("\":{")
                    .append("\"loaded_chunks\":").append(chunks).append(',')
                    .append("\"entities\":").append(entities)
                    .append('}');
        }
        worlds.append('}');

        double[] tps = server.getTPS();
        StringBuilder tpsJson = new StringBuilder("[");
        for (int i = 0; i < tps.length; i++) {
            if (i > 0) {
                tpsJson.append(',');
            }
            tpsJson.append(Json.number(Math.min(tps[i], 20.0)));
        }
        tpsJson.append(']');

        StringBuilder playerJson = new StringBuilder("[");
        for (int i = 0; i < players.size(); i++) {
            if (i > 0) {
                playerJson.append(',');
            }
            playerJson.append('"').append(Json.escape(players.get(i))).append('"');
        }
        playerJson.append(']');

        return "{"
                + "\"online_players\":" + players.size() + ','
                + "\"max_players\":" + server.getMaxPlayers() + ','
                + "\"players\":" + playerJson + ','
                + "\"tps\":" + tpsJson + ','
                + "\"mspt\":" + Json.number(server.getAverageTickTime()) + ','
                + "\"loaded_chunks\":" + totalChunks + ','
                + "\"entities\":" + totalEntities + ','
                + "\"heap_used_mb\":" + heapUsedMb + ','
                + "\"heap_max_mb\":" + heapMaxMb + ','
                + "\"worlds\":" + worlds + ','
                + "\"server_version\":\"" + Json.escape(server.getVersion()) + "\","
                + "\"plugin_version\":\"" + Json.escape(pluginVersion) + "\""
                + "}";
    }

    private long entityCount(World world) {
        if (hasEntityCount) {
            try {
                return (int) World.class.getMethod("getEntityCount").invoke(world);
            } catch (ReflectiveOperationException ignored) {
                // Fall through to the collection size below.
            }
        }
        return world.getEntities().size();
    }

    private static boolean methodExists(Class<?> type, String name) {
        try {
            type.getMethod(name);
            return true;
        } catch (NoSuchMethodException ex) {
            return false;
        }
    }
}
