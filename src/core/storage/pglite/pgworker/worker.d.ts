declare module "pglite.worker" {
	const WorkerFactory: new () => Worker;
	export default WorkerFactory;
}
