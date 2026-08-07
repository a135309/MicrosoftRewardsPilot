export interface ParallelFinalPhaseResult<EdgeResult, VisualResult> {
    edge: EdgeResult
    visual: VisualResult
    edgeError?: unknown
    visualError?: unknown
}

export async function runParallelFinalPhases<EdgeResult, VisualResult>(
    edgeTask: () => Promise<EdgeResult>,
    visualTask: () => Promise<VisualResult>,
    edgeFallback: (error: unknown) => EdgeResult,
    visualFallback: (error: unknown) => VisualResult
): Promise<ParallelFinalPhaseResult<EdgeResult, VisualResult>> {
    const [edgeSettled, visualSettled] = await Promise.allSettled([
        Promise.resolve().then(edgeTask),
        Promise.resolve().then(visualTask)
    ])

    return {
        edge: edgeSettled.status === 'fulfilled' ? edgeSettled.value : edgeFallback(edgeSettled.reason),
        visual: visualSettled.status === 'fulfilled' ? visualSettled.value : visualFallback(visualSettled.reason),
        ...(edgeSettled.status === 'rejected' ? { edgeError: edgeSettled.reason } : {}),
        ...(visualSettled.status === 'rejected' ? { visualError: visualSettled.reason } : {})
    }
}
