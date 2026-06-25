// Command operator is the SynergyPlus controller-manager. In v0.2 it reconciles
// the only CRD — RunnerPool — into a Deployment of Runners plus a KEDA
// ScaledObject (ADR-0006, ADR-0005). It does not create per-run Jobs; the
// workload lives in Postgres. The apiserver, not the operator, owns the Reaper.
package main

import (
	"flag"
	"os"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	synergyv1 "github.com/synergyplus/synergyplus/api/v1"
	"github.com/synergyplus/synergyplus/internal/controller"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(synergyv1.AddToScheme(scheme))
}

// runnerEnv builds the base env passed to every Runner pod (CONTRACT §6). Values
// come from the operator's own environment so a single source configures both.
func runnerEnv() []corev1.EnvVar {
	keys := []string{
		"DATABASE_URL", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY",
		"S3_BUCKET_MODELS", "S3_BUCKET_WEATHER", "S3_BUCKET_RESULTS",
		"SP_LEASE_SECONDS", "SP_HEARTBEAT_SECONDS",
	}
	var env []corev1.EnvVar
	for _, k := range keys {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, corev1.EnvVar{Name: k, Value: v})
		}
	}
	return env
}

// runnerServiceAccount returns the ServiceAccount runner pods should run as,
// from SP_RUNNER_SERVICE_ACCOUNT. On EKS this is set to the IRSA-annotated
// synergyplus-runner SA (keyless scoped S3) via the synergyplus-env Secret.
// Unset (local/OrbStack) leaves it empty → pods use the namespace `default`
// SA and rely on static S3 keys from RunnerEnv instead. We intentionally do
// NOT default to a non-empty SA: a runner pod referencing a SA that doesn't
// exist in the cluster would never schedule, which would break local installs.
func runnerServiceAccount() string {
	return os.Getenv("SP_RUNNER_SERVICE_ACCOUNT")
}

func main() {
	var metricsAddr, probeAddr string
	var enableLeaderElection bool
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "address the metric endpoint binds to")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "address the probe endpoint binds to")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false, "enable leader election for HA")
	opts := zap.Options{Development: true}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "synergyplus.synergyplus.io",
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	if err = (&controller.RunnerPoolReconciler{
		Client:               mgr.GetClient(),
		RunnerEnv:            runnerEnv(),
		RunnerServiceAccount: runnerServiceAccount(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "RunnerPool")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("starting SynergyPlus operator")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}
