package v1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// RunnerPoolSpec is the desired state of a per-EngineVersion pool of Runners
// (PROPOSAL §7.1). The spec is low-churn policy: which version exists, which
// image serves it, and the [min,max] replica bounds KEDA scales within. KEDA
// moves the live replica count from the queue; the spec is never rewritten per
// queue event.
type RunnerPoolSpec struct {
	// EngineVersion is the EnergyPlus release this pool serves, e.g. "24.1.0".
	// It is passed to Runners as SP_ENGINE_VERSION and is the engine_version
	// claimed against in the queue.
	EngineVersion string `json:"engineVersion"`

	// Image is the immutable, digest-pinned Runner image for this version,
	// e.g. ghcr.io/synergyplus/energyplus-runner:24.1.0. Optional: when unset
	// the operator derives the tag from EngineVersion so the CR stays the single
	// source for Engine Version (ADR-0006/ADR-0015), i.e.
	// ghcr.io/synergyplus/energyplus-runner:<engineVersion>. Set it explicitly
	// only to pin a digest or override the registry/repository.
	// +optional
	Image string `json:"image,omitempty"`

	// Resources is the compute request for a single Runner pod. EnergyPlus is
	// single-threaded, so CPU defaults to one core.
	// +optional
	Resources RunnerResources `json:"resources,omitempty"`

	// MinReplicas is the warm floor. Default 0 (scale-to-zero); raise it if
	// first-run latency on a cold pool bites (ADR-0005).
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:default=0
	// +optional
	MinReplicas int32 `json:"minReplicas,omitempty"`

	// MaxReplicas is the ceiling KEDA may scale this pool to.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:default=200
	// +optional
	MaxReplicas int32 `json:"maxReplicas,omitempty"`

	// DefaultUserConcurrency is the per-User concurrency cap this pool enforces
	// (SP_PER_USER_CAP). It is also the cap used by the KEDA eligible-depth
	// trigger so scaler and claimer agree (ADR-0005).
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:default=50
	// +optional
	DefaultUserConcurrency int32 `json:"defaultUserConcurrency,omitempty"`
}

// RunnerResources is the compute request/limit for a single Runner pod.
type RunnerResources struct {
	// +kubebuilder:default="1"
	// +optional
	CPU string `json:"cpu,omitempty"`
	// +kubebuilder:default="2Gi"
	// +optional
	Memory string `json:"memory,omitempty"`
}

// RunnerPoolStatus is the observed state of a RunnerPool. eligibleQueued is
// surfaced on a throttled interval, never per queue event (PROPOSAL §7.1).
type RunnerPoolStatus struct {
	// ReadyReplicas mirrors the backing Deployment's ready replicas.
	// +optional
	ReadyReplicas int32 `json:"readyReplicas,omitempty"`

	// EligibleQueued is the count of claimable queued Simulations for this
	// version (the KEDA trigger's eligibility predicate), surfaced throttled.
	// +optional
	EligibleQueued int32 `json:"eligibleQueued,omitempty"`

	// Conditions follows the standard Kubernetes condition convention.
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=rp
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.spec.engineVersion`
// +kubebuilder:printcolumn:name="Min",type=integer,JSONPath=`.spec.minReplicas`
// +kubebuilder:printcolumn:name="Max",type=integer,JSONPath=`.spec.maxReplicas`
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Eligible",type=integer,JSONPath=`.status.eligibleQueued`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// RunnerPool is the only SynergyPlus CRD (ADR-0006): a per-version pool of
// EnergyPlus Runners, reconciled into a Deployment + a KEDA ScaledObject.
type RunnerPool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   RunnerPoolSpec   `json:"spec,omitempty"`
	Status RunnerPoolStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// RunnerPoolList is a list of RunnerPools.
type RunnerPoolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []RunnerPool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&RunnerPool{}, &RunnerPoolList{})
}
