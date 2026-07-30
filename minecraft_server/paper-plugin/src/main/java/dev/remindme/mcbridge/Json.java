package dev.remindme.mcbridge;

/**
 * Minimal JSON helpers.
 *
 * <p>The plugin writes a handful of well-known fields once per second. Hand-rolling
 * the two escapes it needs keeps the jar free of shaded dependencies, which is the
 * difference between a few kilobytes and a megabyte of classes that could clash
 * with the server's own.
 */
final class Json {

    private Json() {
    }

    static String escape(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        return out.toString();
    }

    /** number renders a double without a locale-dependent decimal separator. */
    static String number(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            return "0";
        }
        return String.format(java.util.Locale.ROOT, "%.2f", value);
    }
}
