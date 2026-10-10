"""Learn from earned lazer judgment points, scaled for the optimizer."""

REVISION = 'lazer-judgment-points-v1'
DISCOUNT = .99


def judgment_reward(points):
    # Great/Ok/Meh: 300/100/50; tick/repeat: 30; tail: 150; miss: 0.
    return points / 300
