// Package v1 contains the API schema definitions for the synergyplus.io v1 API
// group. In v0.2 the only custom resource is RunnerPool (ADR-0006): Simulations
// and Batches are Postgres rows, not Kubernetes objects.
//
// +kubebuilder:object:generate=true
// +groupName=synergyplus.io
package v1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is the group/version used to register these objects.
	GroupVersion = schema.GroupVersion{Group: "synergyplus.io", Version: "v1"}

	// SchemeBuilder registers the API types with a runtime.Scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

	// AddToScheme adds the types in this group-version to the given scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)
