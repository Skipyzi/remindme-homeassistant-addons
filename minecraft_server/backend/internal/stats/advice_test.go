package stats

import "testing"

func TestAdviseMemoryOnAPi5(t *testing.T) {
	// 8 GB Pi sharing with Home Assistant: the documented ceiling is 3.5 GB.
	advice := AdviseMemory(8<<30, 3072)
	if advice.RecommendedMaxHeapMB != 3584 {
		t.Fatalf("expected a 3584 MB ceiling on 8 GB, got %d", advice.RecommendedMaxHeapMB)
	}
	if advice.Exceeded {
		t.Fatal("3072 is under the ceiling and must not warn")
	}
	over := AdviseMemory(8<<30, 6144)
	if !over.Exceeded {
		t.Fatal("6144 MB on an 8 GB machine must warn")
	}
}

func TestAdviseMemorySmallAndUnknownMachines(t *testing.T) {
	// A 4 GB machine still gets a workable floor rather than a negative number.
	small := AdviseMemory(4<<30, 2048)
	if small.RecommendedMaxHeapMB != adviceFloorMB {
		t.Fatalf("expected the %d MB floor, got %d", adviceFloorMB, small.RecommendedMaxHeapMB)
	}
	if !small.Exceeded {
		t.Fatal("2048 over a 1024 floor must warn")
	}
	// Unknown total (development hosts) gives no advice and never warns.
	unknown := AdviseMemory(0, 4096)
	if unknown.Exceeded || unknown.RecommendedMaxHeapMB != 0 {
		t.Fatalf("no advice without a memory total: %+v", unknown)
	}
}

func TestClassifyDevice(t *testing.T) {
	cases := map[string]string{
		"/dev/mmcblk0p2": "sd-card",
		"/dev/nvme0n1p3": "nvme",
		"overlay":        "",
		"":               "",
	}
	for device, want := range cases {
		if got := classifyDevice(device, t.TempDir()); got != want {
			t.Errorf("classifyDevice(%q) = %q, want %q", device, got, want)
		}
	}
}
