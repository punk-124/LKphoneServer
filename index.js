import { Hono } from 'hono'
import { cors } from 'hono/cors'
import commentsRoutes from './routes/comments'
import groupsRoutes from './routes/groups'
import resourcesRoutes from './routes/resources'
import syncRoutes from './routes/sync'
import systemRoutes from './routes/system'

const app = new Hono()

app.use('*', cors())

app.route('/', systemRoutes)
app.route('/resources', resourcesRoutes)
app.route('/comments', commentsRoutes)
app.route('/groups', groupsRoutes)
app.route('/sync', syncRoutes)

export default app
