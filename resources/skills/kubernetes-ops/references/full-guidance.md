# Kubernetes Operations

You are a Kubernetes operations specialist. Use the `run_command` tool to execute kubectl/helm commands and file tools to create manifests.

## Core kubectl Operations

### Resource Management
```bash
kubectl get pods -A                           # All pods across namespaces
kubectl get pods -n default -o wide           # Pods with node/IP info
kubectl get deploy,svc,ingress -n app         # Multiple resource types
kubectl describe pod my-pod -n app            # Detailed resource info
kubectl logs my-pod -n app --tail=100 -f      # Stream logs
kubectl logs my-pod -c sidecar -n app         # Specific container logs
kubectl exec -it my-pod -n app -- /bin/sh     # Interactive shell
kubectl port-forward svc/my-svc 8080:80 -n app  # Local port forward
```

### Apply & Delete
```bash
kubectl apply -f manifests/                    # Apply directory of manifests
kubectl apply -f deployment.yaml               # Apply single file
kubectl delete pod my-pod -n app               # Delete resource
kubectl delete -f deployment.yaml              # Delete by manifest
kubectl rollout restart deploy/my-app -n app   # Rolling restart
kubectl rollout undo deploy/my-app -n app      # Rollback to previous
kubectl rollout status deploy/my-app -n app    # Watch rollout progress
```

### Context & Cluster
```bash
kubectl config get-contexts                    # List available contexts
kubectl config use-context production          # Switch context
kubectl config current-context                 # Show current
kubectl cluster-info                           # Cluster endpoint info
```

## Manifest Generation Patterns

### Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: app
  labels:
    app: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: my-app:1.0.0
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        env:
        - name: DB_HOST
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: host
```

### Service + Ingress
```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: app
spec:
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 8080
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  namespace: app
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - app.example.com
    secretName: app-tls
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-app
            port:
              number: 80
```

### ConfigMap & Secret
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: app
data:
  APP_ENV: production
  LOG_LEVEL: info
---
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: app
type: Opaque
stringData:
  host: db.example.com
  password: changeme
```

### HPA (Autoscaling)
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app
  namespace: app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## Helm Operations
```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm search repo nginx
helm install my-release bitnami/nginx -n app -f values.yaml
helm upgrade my-release bitnami/nginx -n app -f values.yaml
helm rollback my-release 1 -n app
helm template my-release bitnami/nginx -f values.yaml  # Dry-run render
helm list -A                                            # All releases
helm history my-release -n app                          # Release history
```

## RBAC
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: app-reader
  namespace: app
rules:
- apiGroups: [""]
  resources: ["pods", "services", "configmaps"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: app-reader-binding
  namespace: app
subjects:
- kind: ServiceAccount
  name: app-sa
  namespace: app
roleRef:
  kind: Role
  name: app-reader
  apiGroup: rbac.authorization.k8s.io
```

## Debugging Checklist
1. `kubectl get events -n app --sort-by=.lastTimestamp` - Recent events
2. `kubectl describe pod <pod> -n app` - Pod conditions and events
3. `kubectl logs <pod> -n app --previous` - Previous container logs (crash loops)
4. `kubectl get pod <pod> -o yaml` - Full spec with status
5. `kubectl top pods -n app` - CPU/memory usage
6. `kubectl run debug --rm -it --image=busybox -- /bin/sh` - Ephemeral debug pod

## Kustomize
```bash
kubectl apply -k overlays/production/    # Apply kustomization
kubectl kustomize overlays/production/   # Preview rendered output
```

## Best Practices
- Always set resource requests and limits
- Use liveness and readiness probes
- Store sensitive data in Secrets, not ConfigMaps
- Use namespaces for isolation
- Set PodDisruptionBudgets for HA workloads
- Use `--dry-run=client -o yaml` to generate manifest templates
- Label everything: `app`, `version`, `team`, `environment`
