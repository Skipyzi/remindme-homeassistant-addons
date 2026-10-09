"""Keep the playable field's pixel density while including its surroundings."""
PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT = 512,384
PIXELS_PER_UNIT = 1/8
PADDING = 8
WIDTH,HEIGHT = 80,64
OBSERVATION_SHAPE = (4,HEIGHT,WIDTH)
FEATURE_HEIGHT,FEATURE_WIDTH = 14,18
LEGACY_OBSERVATION_SHAPE = (4,48,64)
LEGACY_FEATURE_HEIGHT,LEGACY_FEATURE_WIDTH = 10,14
FEATURE_OFFSET = PADDING//4


def view():
    return {'width':WIDTH,'height':HEIGHT,'scale':PIXELS_PER_UNIT,
            'offset_x':PADDING,'offset_y':PADDING,
            'world_left':-PADDING/PIXELS_PER_UNIT,'world_top':-PADDING/PIXELS_PER_UNIT,
            'world_width':WIDTH/PIXELS_PER_UNIT,'world_height':HEIGHT/PIXELS_PER_UNIT}
