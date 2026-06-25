// Package controller holds the SynergyPlus operator's reconcilers. In v0.2 the
// only reconciler is RunnerPoolReconciler: there are no per-run Job controllers
// (ADR-0001, ADR-0006). Simulations/Batches live in Postgres; this operator only
// manages worker capacity.
package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	synergyv1 "github.com/synergyplus/synergyplus/api/v1"
)

// scaledObjectGVK is the KEDA ScaledObject type, referenced as unstructured so
// the operator needn't vendor the KEDA API module.
var scaledObjectGVK = schema.GroupVersionKind{Group: "keda.sh", Version: "v1alpha1", Kind: "ScaledObject"}

// RunnerPoolReconciler reconciles a RunnerPool into a Deployment of Runners plus
// a KEDA ScaledObject scaling on eligible queue depth (PROPOSAL §6.3, ADR-0005).
type RunnerPoolReconciler struct {
	client.Client
	Scheme *runtime.Scheme

	// RunnerEnv is the base environment passed through to Runner pods (CONTRACT
	// §6: DATABASE_URL + S3 creds), injected from the operator's own environment.
	RunnerEnv []corev1.EnvVar
}

// +kubebuilder:rbac:groups=synergyplus.io,resources=runnerpools,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=synergyplus.io,resources=runnerpools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=synergyplus.io,resources=runnerpools/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=keda.sh,resources=scaledobjects,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch

// Reconcile ensures the Deployment and ScaledObject for a RunnerPool exist and
// match the spec, and reflects readyReplicas in status.
func (r *RunnerPoolReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var pool synergyv1.RunnerPool
	if err := r.Get(ctx, req.NamespacedName, &pool); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if err := r.reconcileDeployment(ctx, &pool); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile deployment: %w", err)
	}
	if err := r.reconcileScaledObject(ctx, &pool); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile scaledobject: %w", err)
	}

	// Reflect ready replicas in status (best effort).
	var dep appsv1.Deployment
	if err := r.Get(ctx, deployKey(&pool), &dep); err == nil {
		if pool.Status.ReadyReplicas != dep.Status.ReadyReplicas {
			pool.Status.ReadyReplicas = dep.Status.ReadyReplicas
			if err := r.Status().Update(ctx, &pool); err != nil {
				logger.Error(err, "status update")
			}
		}
	}

	return ctrl.Result{}, nil
}

func (r *RunnerPoolReconciler) reconcileDeployment(ctx context.Context, pool *synergyv1.RunnerPool) error {
	cpu := pool.Spec.Resources.CPU
	if cpu == "" {
		cpu = "1"
	}
	mem := pool.Spec.Resources.Memory
	if mem == "" {
		mem = "2Gi"
	}
	cpuQ, err := resource.ParseQuantity(cpu)
	if err != nil {
		return fmt.Errorf("parse cpu %q: %w", cpu, err)
	}
	memQ, err := resource.ParseQuantity(mem)
	if err != nil {
		return fmt.Errorf("parse memory %q: %w", mem, err)
	}

	labels := map[string]string{
		"app.kubernetes.io/name":       "synergyplus-runner",
		"app.kubernetes.io/managed-by": "synergyplus-operator",
		"synergyplus.io/pool":          pool.Name,
		"synergyplus.io/engine":        pool.Spec.EngineVersion,
	}

	// Runner env: CONTRACT §6 base (DATABASE_URL + S3) plus per-pool overrides.
	env := append([]corev1.EnvVar{}, r.RunnerEnv...)
	env = append(env,
		corev1.EnvVar{Name: "SP_ENGINE_VERSION", Value: pool.Spec.EngineVersion},
		corev1.EnvVar{Name: "SP_PER_USER_CAP", Value: fmt.Sprintf("%d", caps(pool.Spec.DefaultUserConcurrency, 50))},
		corev1.EnvVar{Name: "SP_RUNNER_ID", ValueFrom: &corev1.EnvVarSource{
			FieldRef: &corev1.ObjectFieldSelector{FieldPath: "metadata.name"},
		}},
	)

	desired := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: deployName(pool), Namespace: pool.Namespace, Labels: labels},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"synergyplus.io/pool": pool.Name}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{
						Name:  "runner",
						Image: pool.Spec.Image,
						Env:   env,
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    cpuQ,
								corev1.ResourceMemory: memQ,
							},
							Limits: corev1.ResourceList{corev1.ResourceMemory: memQ},
						},
					}},
				},
			},
		},
	}
	// KEDA owns .spec.replicas once the ScaledObject is active; we deliberately
	// leave replicas unset so reconciliation does not fight the autoscaler.

	if err := ctrl.SetControllerReference(pool, desired, r.Scheme); err != nil {
		return err
	}

	var existing appsv1.Deployment
	err = r.Get(ctx, types.NamespacedName{Name: desired.Name, Namespace: desired.Namespace}, &existing)
	if err != nil {
		if client.IgnoreNotFound(err) != nil {
			return err
		}
		return r.Create(ctx, desired)
	}
	existing.Labels = desired.Labels
	existing.Spec.Selector = desired.Spec.Selector
	existing.Spec.Template = desired.Spec.Template
	return r.Update(ctx, &existing)
}

func (r *RunnerPoolReconciler) reconcileScaledObject(ctx context.Context, pool *synergyv1.RunnerPool) error {
	min := int64(pool.Spec.MinReplicas)
	max := int64(caps(pool.Spec.MaxReplicas, 200))
	userCap := caps(pool.Spec.DefaultUserConcurrency, 50)

	// The KEDA trigger uses the eligible-depth query: the claim predicate from
	// CONTRACT §2.2 WITHOUT the UPDATE (count of claimable rows for this version).
	// ADR-0011: the predicate now lives in app.eligible_simulations (migration
	// 0006); count its rows so the scaler and the Runner's claim stay in lockstep.
	eligibleQuery := fmt.Sprintf(
		`SELECT count(*) FROM app.eligible_simulations('%s', %d)`,
		pool.Spec.EngineVersion, userCap)

	so := &unstructured.Unstructured{}
	so.SetGroupVersionKind(scaledObjectGVK)
	so.SetName(scaledObjectName(pool))
	so.SetNamespace(pool.Namespace)
	so.SetLabels(map[string]string{"synergyplus.io/pool": pool.Name})

	spec := map[string]any{
		"scaleTargetRef":  map[string]any{"name": deployName(pool)},
		"minReplicaCount": min,
		"maxReplicaCount": max,
		"triggers": []any{
			map[string]any{
				"type": "postgresql",
				"metadata": map[string]any{
					// connectionFromEnv references an env var on the runner /
					// KEDA-resolved TriggerAuthentication in a real install; here we
					// reference DATABASE_URL by convention.
					"connectionFromEnv": "DATABASE_URL",
					"query":             eligibleQuery,
					"targetQueryValue":  "1",
				},
			},
		},
	}
	if err := unstructured.SetNestedField(so.Object, spec, "spec"); err != nil {
		return err
	}
	if err := ctrl.SetControllerReference(pool, so, r.Scheme); err != nil {
		return err
	}

	existing := &unstructured.Unstructured{}
	existing.SetGroupVersionKind(scaledObjectGVK)
	err := r.Get(ctx, types.NamespacedName{Name: so.GetName(), Namespace: so.GetNamespace()}, existing)
	if err != nil {
		if client.IgnoreNotFound(err) != nil {
			return err
		}
		return r.Create(ctx, so)
	}
	so.SetResourceVersion(existing.GetResourceVersion())
	return r.Update(ctx, so)
}

// SetupWithManager wires the reconciler and its owned types.
func (r *RunnerPoolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.Scheme = mgr.GetScheme()
	return ctrl.NewControllerManagedBy(mgr).
		For(&synergyv1.RunnerPool{}).
		Owns(&appsv1.Deployment{}).
		Complete(r)
}

func deployName(p *synergyv1.RunnerPool) string      { return "runner-" + p.Name }
func scaledObjectName(p *synergyv1.RunnerPool) string { return "runner-" + p.Name }
func deployKey(p *synergyv1.RunnerPool) types.NamespacedName {
	return types.NamespacedName{Name: deployName(p), Namespace: p.Namespace}
}

func caps(v, def int32) int32 {
	if v <= 0 {
		return def
	}
	return v
}
