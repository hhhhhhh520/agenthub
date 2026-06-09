from flask import Flask, request, jsonify
import uuid
from datetime import datetime, timezone

app = Flask(__name__)

# In-memory storage
todos = []


@app.route('/todos', methods=['GET'])
def get_todos():
    """Get all todos, optionally filtered by completed status"""
    completed = request.args.get('completed')
    
    if completed is not None:
        filtered = [t for t in todos if t['completed'] == (completed.lower() == 'true')]
        return jsonify(filtered), 200
    
    return jsonify(todos), 200


@app.route('/todos/<todo_id>', methods=['GET'])
def get_todo(todo_id):
    """Get a single todo by ID"""
    todo = next((t for t in todos if t['id'] == todo_id), None)
    
    if not todo:
        return jsonify({'error': 'Todo not found'}), 404
    
    return jsonify(todo), 200


@app.route('/todos', methods=['POST'])
def create_todo():
    """Create a new todo"""
    data = request.get_json()
    
    if not data or 'title' not in data:
        return jsonify({'error': 'Title is required'}), 400
    
    todo = {
        'id': str(uuid.uuid4()),
        'title': data['title'],
        'description': data.get('description', ''),
        'completed': False,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat()
    }
    
    todos.append(todo)
    return jsonify(todo), 201


@app.route('/todos/<todo_id>', methods=['PUT'])
def update_todo(todo_id):
    """Update an existing todo"""
    todo = next((t for t in todos if t['id'] == todo_id), None)
    
    if not todo:
        return jsonify({'error': 'Todo not found'}), 404
    
    data = request.get_json()
    
    if not data:
        return jsonify({'error': 'Request body is required'}), 400
    
    if 'title' in data:
        todo['title'] = data['title']
    if 'description' in data:
        todo['description'] = data['description']
    if 'completed' in data:
        todo['completed'] = data['completed']
    
    todo['updated_at'] = datetime.now(timezone.utc).isoformat()
    
    return jsonify(todo), 200


@app.route('/todos/<todo_id>', methods=['DELETE'])
def delete_todo(todo_id):
    """Delete a todo"""
    global todos
    todo = next((t for t in todos if t['id'] == todo_id), None)
    
    if not todo:
        return jsonify({'error': 'Todo not found'}), 404
    
    todos = [t for t in todos if t['id'] != todo_id]
    return jsonify({'message': 'Todo deleted'}), 200


@app.route('/todos', methods=['DELETE'])
def clear_todos():
    """Clear all todos"""
    global todos
    todos.clear()
    return jsonify({'message': 'All todos cleared'}), 200


def reset_todos():
    """Helper to reset todos (for testing)"""
    global todos
    todos.clear()


if __name__ == '__main__':
    app.run(debug=True, port=5000)
