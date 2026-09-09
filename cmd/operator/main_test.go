package main

import "testing"

// TestParseTolerations covers SP_RUNNER_TOLERATIONS, which is how the spot
// NodePool's taint reaches Runner pods. The empty case has to stay empty: a
// local install has no tainted capacity, and defaulting to a toleration there
// would let runners land wherever. The malformed case has to be an error
// rather than an empty slice, because an empty slice is silent and puts the
// whole pool back on on-demand capacity, which is the bug this exists to fix.
func TestParseTolerations(t *testing.T) {
	t.Run("unset means none", func(t *testing.T) {
		got, err := parseTolerations("")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != nil {
			t.Fatalf("want nil, got %#v", got)
		}
	})

	t.Run("the spot taint round-trips", func(t *testing.T) {
		got, err := parseTolerations(
			`[{"key":"synergyplus.io/runner","operator":"Equal","value":"true","effect":"NoSchedule"}]`,
		)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 1 {
			t.Fatalf("want 1 toleration, got %d", len(got))
		}
		if got[0].Key != "synergyplus.io/runner" || got[0].Value != "true" {
			t.Fatalf("key/value not preserved: %#v", got[0])
		}
		if got[0].Effect != "NoSchedule" || got[0].Operator != "Equal" {
			t.Fatalf("effect/operator not preserved: %#v", got[0])
		}
	})

	t.Run("malformed is an error, never an empty list", func(t *testing.T) {
		if _, err := parseTolerations("not json"); err == nil {
			t.Fatal("want an error for malformed input")
		}
		if _, err := parseTolerations(`{"key":"x"}`); err == nil {
			t.Fatal("want an error for an object where an array belongs")
		}
	})
}
