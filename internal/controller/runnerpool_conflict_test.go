package controller

import (
	"context"
	"errors"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	synergyv1 "github.com/synergyplus/synergyplus/api/v1"
)

// conflictingClient rejects the first `conflicts` writes the way the API server
// does when something else has written the object since it was read. KEDA is
// that something else: it owns .spec.replicas on the very Deployment this
// controller rewrites, and it writes continuously while a queue is deep.
type conflictingClient struct {
	client.Client
	conflicts int
	updates   int
}

func (c *conflictingClient) Update(ctx context.Context, obj client.Object, opts ...client.UpdateOption) error {
	c.updates++
	if c.conflicts > 0 {
		c.conflicts--
		return apierrors.NewConflict(
			schema.GroupResource{Group: "apps", Resource: "deployments"},
			obj.GetName(),
			errors.New("the object has been modified; please apply your changes to the latest version and try again"),
		)
	}
	return c.Client.Update(ctx, obj, opts...)
}

// TestReconcileDeploymentRetriesOnConflict pins the fix for the lab-cluster
// failure of 2026-09-09: the runner tolerations could not be written at all
// while KEDA was scaling, because every reconcile read, lost the race, and
// returned - so the pods never reached the spot NodePool and the controller
// spun on "the object has been modified".
func TestReconcileDeploymentRetriesOnConflict(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatalf("core scheme: %v", err)
	}
	if err := synergyv1.AddToScheme(scheme); err != nil {
		t.Fatalf("synergy scheme: %v", err)
	}

	pool := &synergyv1.RunnerPool{
		ObjectMeta: metav1.ObjectMeta{Name: "eplus-24-2-0", Namespace: "synergy-system"},
		Spec:       synergyv1.RunnerPoolSpec{EngineVersion: "24.2.0"},
	}
	// The Deployment already exists, as it does on a live cluster: this is an
	// update, not a create, which is the only path a conflict can reach.
	existing := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "runner-eplus-24-2-0", Namespace: "synergy-system"},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"synergyplus.io/pool": pool.Name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"synergyplus.io/pool": pool.Name}},
				Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "runner", Image: "old"}}},
			},
		},
	}

	toleration := corev1.Toleration{
		Key: "synergyplus.io/runner", Operator: corev1.TolerationOpEqual,
		Value: "true", Effect: corev1.TaintEffectNoSchedule,
	}
	inner := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pool, existing).Build()
	c := &conflictingClient{Client: inner, conflicts: 2}
	r := &RunnerPoolReconciler{
		Client:            c,
		Scheme:            scheme,
		RunnerTolerations: []corev1.Toleration{toleration},
	}

	if err := r.reconcileDeployment(context.Background(), pool); err != nil {
		t.Fatalf("reconcileDeployment: %v", err)
	}
	if c.updates != 3 {
		t.Errorf("updates = %d, want 3 (two conflicts then the write that lands)", c.updates)
	}

	var got appsv1.Deployment
	key := types.NamespacedName{Name: "runner-eplus-24-2-0", Namespace: "synergy-system"}
	if err := inner.Get(context.Background(), key, &got); err != nil {
		t.Fatalf("get deployment: %v", err)
	}
	tolerations := got.Spec.Template.Spec.Tolerations
	if len(tolerations) != 1 || tolerations[0].Key != toleration.Key {
		t.Errorf("tolerations = %v, want the runner taint to have landed", tolerations)
	}
}
