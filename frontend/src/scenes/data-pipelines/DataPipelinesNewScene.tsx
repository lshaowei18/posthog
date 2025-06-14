import { kea, path, props, selectors, useValues } from 'kea'
import { FlaggedFeature } from 'lib/components/FlaggedFeature'
import { NotFound } from 'lib/components/NotFound'
import { capitalizeFirstLetter } from 'lib/utils'
import { NewSourceWizardScene } from 'scenes/data-warehouse/new/NewSourceWizard'
import { HogFunctionTemplateList } from 'scenes/hog-functions/list/HogFunctionTemplateList'
import { Scene, SceneExport } from 'scenes/sceneTypes'
import { urls } from 'scenes/urls'

import { Breadcrumb } from '~/types'

import type { dataPipelinesNewSceneLogicType } from './DataPipelinesNewSceneType'

export type DataPipelinesNewSceneProps = {
    kind: 'transformation' | 'destination' | 'source' | 'site_app'
}

export const dataPipelinesNewSceneLogic = kea<dataPipelinesNewSceneLogicType>([
    props({} as DataPipelinesNewSceneProps),
    path(() => ['scenes', 'data-pipelines', 'dataPipelinesNewSceneLogic']),
    selectors({
        logicProps: [() => [(_, props) => props], (props) => props],
        breadcrumbs: [
            () => [(_, props) => props],
            ({ kind }): Breadcrumb[] => {
                return [
                    {
                        key: Scene.DataPipelines,
                        name: 'Data pipelines',
                        path: urls.dataPipelines('overview'),
                    },
                    {
                        key: Scene.DataPipelines,
                        name: capitalizeFirstLetter(kind) + 's',
                        path: urls.dataPipelines(kind + 's'),
                    },
                    {
                        key: Scene.DataPipelinesNew,
                        name: 'New',
                    },
                ]
            },
        ],
    }),
])

export const scene: SceneExport = {
    component: DataPipelinesNewScene,
    logic: dataPipelinesNewSceneLogic,
    paramsToProps: ({ params: { kind } }): (typeof dataPipelinesNewSceneLogic)['props'] => ({
        kind,
    }),
}

export function DataPipelinesNewScene(): JSX.Element {
    const { logicProps } = useValues(dataPipelinesNewSceneLogic)
    const { kind } = logicProps

    if (['transformation', 'destination', 'site_app'].includes(kind)) {
        return <HogFunctionTemplateList type={kind} />
    }

    if (kind === 'source') {
        return (
            <>
                <FlaggedFeature flag="cdp-hog-sources">
                    <h2>Event sources</h2>
                    <HogFunctionTemplateList type="source_webhook" />
                </FlaggedFeature>
                <NewSourceWizardScene />
            </>
        )
    }

    return <NotFound object="Data pipeline new options" />
}
