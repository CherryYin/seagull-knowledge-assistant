from pkg.api.app import app


def test_memory_product_router_is_not_registered():
    product_memory_routes = [
        route.path
        for route in app.routes
        if getattr(route, "path", "") == "/memory" or getattr(route, "path", "").startswith("/memory/")
    ]

    assert product_memory_routes == []
