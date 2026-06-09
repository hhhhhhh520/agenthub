import pytest
import json
from app import app, reset_todos


@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        reset_todos()
        yield client


@pytest.fixture
def sample_todo(client):
    response = client.post('/todos',
                          data=json.dumps({'title': 'Test Todo', 'description': 'Test Description'}),
                          content_type='application/json')
    return json.loads(response.data)


class TestGetTodos:

    def test_get_empty_todos(self, client):
        response = client.get('/todos')
        assert response.status_code == 200
        assert json.loads(response.data) == []

    def test_get_all_todos(self, client, sample_todo):
        response = client.get('/todos')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert len(data) == 1
        assert data[0]['title'] == 'Test Todo'

    def test_get_todos_filter_completed(self, client, sample_todo):
        todo_id = sample_todo['id']
        client.put('/todos/' + todo_id,
                  data=json.dumps({'completed': True}),
                  content_type='application/json')
        response = client.get('/todos?completed=true')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert len(data) == 1
        assert data[0]['completed'] == True
        response = client.get('/todos?completed=false')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert len(data) == 0


class TestGetTodo:

    def test_get_existing_todo(self, client, sample_todo):
        todo_id = sample_todo['id']
        response = client.get('/todos/' + todo_id)
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data['id'] == todo_id
        assert data['title'] == 'Test Todo'

    def test_get_nonexistent_todo(self, client):
        response = client.get('/todos/nonexistent-id')
        assert response.status_code == 404
        data = json.loads(response.data)
        assert 'error' in data


class TestCreateTodo:

    def test_create_todo_success(self, client):
        todo_data = {'title': 'New Todo', 'description': 'New Description'}
        response = client.post('/todos',
                              data=json.dumps(todo_data),
                              content_type='application/json')
        assert response.status_code == 201
        data = json.loads(response.data)
        assert data['title'] == 'New Todo'
        assert data['description'] == 'New Description'
        assert data['completed'] == False
        assert 'id' in data
        assert 'created_at' in data

    def test_create_todo_without_description(self, client):
        todo_data = {'title': 'Todo Without Description'}
        response = client.post('/todos',
                              data=json.dumps(todo_data),
                              content_type='application/json')
        assert response.status_code == 201
        data = json.loads(response.data)
        assert data['description'] == ''

    def test_create_todo_missing_title(self, client):
        todo_data = {'description': 'Missing Title'}
        response = client.post('/todos',
                              data=json.dumps(todo_data),
                              content_type='application/json')
        assert response.status_code == 400
        data = json.loads(response.data)
        assert 'error' in data

    def test_create_todo_empty_body(self, client):
        response = client.post('/todos',
                              data=json.dumps({}),
                              content_type='application/json')
        assert response.status_code == 400


class TestUpdateTodo:

    def test_update_todo_success(self, client, sample_todo):
        todo_id = sample_todo['id']
        update_data = {'title': 'Updated Title', 'completed': True}
        response = client.put('/todos/' + todo_id,
                             data=json.dumps(update_data),
                             content_type='application/json')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data['title'] == 'Updated Title'
        assert data['completed'] == True

    def test_update_nonexistent_todo(self, client):
        update_data = {'title': 'Updated'}
        response = client.put('/todos/nonexistent-id',
                             data=json.dumps(update_data),
                             content_type='application/json')
        assert response.status_code == 404

    def test_update_todo_partial(self, client, sample_todo):
        todo_id = sample_todo['id']
        update_data = {'title': 'Only Title Updated'}
        response = client.put('/todos/' + todo_id,
                             data=json.dumps(update_data),
                             content_type='application/json')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data['title'] == 'Only Title Updated'
        assert data['description'] == 'Test Description'


class TestDeleteTodo:

    def test_delete_todo_success(self, client, sample_todo):
        todo_id = sample_todo['id']
        response = client.delete('/todos/' + todo_id)
        assert response.status_code == 200
        response = client.get('/todos/' + todo_id)
        assert response.status_code == 404

    def test_delete_nonexistent_todo(self, client):
        response = client.delete('/todos/nonexistent-id')
        assert response.status_code == 404


class TestClearTodos:

    def test_clear_all_todos(self, client, sample_todo):
        response = client.delete('/todos')
        assert response.status_code == 200
        response = client.get('/todos')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert len(data) == 0


class TestTodoStructure:

    def test_todo_has_required_fields(self, client, sample_todo):
        required_fields = ['id', 'title', 'description', 'completed', 'created_at', 'updated_at']
        for field in required_fields:
            assert field in sample_todo, 'Missing field: ' + field

    def test_todo_id_is_string(self, client, sample_todo):
        assert isinstance(sample_todo['id'], str)

    def test_todo_completed_is_boolean(self, client, sample_todo):
        assert isinstance(sample_todo['completed'], bool)
